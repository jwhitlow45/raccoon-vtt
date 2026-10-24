import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS } from "#shared/limits.ts";
import type { ClassResource } from "#shared/model.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { asInputs, fromPreset, presetById } from "#shared/rules/classResources.ts";
import {
  addOutcome,
  amountOutcome,
  backLabel,
  blockModifiers,
  countText,
  countWords,
  defaultTicks,
  editDraft,
  editOutcome,
  emptyText,
  EMPTY_OWN,
  firstLevel,
  joinWords,
  ownOutcome,
  pickClass,
  pickHelp,
  pickLevel,
  pickRows,
  reasonText,
  removeOutcome,
  restBackText,
  startPick,
  startUpdate,
  tick,
  updateOutcome,
  useLabel,
  type PickDraft,
} from "./logic.ts";

/*
 * A character's class resources as the section, the rows and the sheets
 * read and change them (docs/design-v1-combat-controls.md 7): every list a
 * sheet sends goes through character.update's own schema here, so a
 * change the server's schema would refuse fails a test first.
 */

const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};

const sendable = (resources: unknown) => {
  const parsed = clientOpSchema.safeParse({ t: "character.update", characterId: "pat", patch: { resources } });
  assert.ok(parsed.success, JSON.stringify(resources));
};

const rage: ClassResource = { id: "rage", name: "Rage", max: 3, used: 1, reset: "shortOne", preset: "barbarian-rage", level: 5, atLevel: 5 };
const focus: ClassResource = { id: "focus", name: "Focus Points", max: 5, used: 2, reset: "short", pool: true, preset: "monk-focus-points", level: 5, atLevel: 5 };
const surge: ClassResource = { id: "surge", name: "Action Surge", max: 1, used: 1, reset: "short", preset: "fighter-action-surge", level: 2, atLevel: 5 };
const hands: ClassResource = { id: "hands", name: "Lay on Hands", max: 25, used: 0, reset: "long", pool: true, preset: "paladin-lay-on-hands", level: 5, atLevel: 5 };

describe("a resource's row", () => {
  test("its count is what is left of the most, and Use says it", () => {
    assert.equal(countText(rage), "2 of 3");
    assert.equal(countText({ max: 3, used: 3 }), "0 of 3");
    assert.equal(useLabel(rage), "Use Rage, 2 of 3 left");
    assert.equal(useLabel(hands), "Use Lay on Hands, 25 of 25 left");
  });

  test("Give back and an empty Use say what they are about", () => {
    assert.equal(backLabel(rage), "Give one back: Rage");
    assert.equal(backLabel(hands), "Give back Lay on Hands");
    assert.equal(emptyText(rage), "Rage has no uses left.");
    assert.equal(emptyText(hands), "No Lay on Hands is left.");
  });

  test("a refusal reads as the server's reason alone", () => {
    assert.equal(reasonText({ message: "Rage has no uses left.", text: "Not saved. Rage has no uses left." }), "Rage has no uses left.");
    assert.equal(reasonText({ message: "that is not yours", text: "That is not yours." }), "That is not yours.");
    assert.equal(reasonText({ message: " ", text: "Not saved." }), "Not saved.");
    assert.equal(reasonText(undefined), "That could not be done.");
  });

  test("a pool's amount is a whole number from 1 to what it may take", () => {
    assert.deepEqual(amountOutcome("5", 25, "Spend"), { ok: true, amount: 5 });
    assert.deepEqual(amountOutcome(" 25 ", 25, "Spend"), { ok: true, amount: 25 });
    assert.deepEqual(amountOutcome("1", 1, "Give back"), { ok: true, amount: 1 });
    for (const bad of ["", "0", "26", "2.5", "-1", "five", "1e1"]) assert.deepEqual(amountOutcome(bad, 25, "Spend"), { ok: false, error: "Spend 1 to 25." }, bad);
    assert.deepEqual(amountOutcome("2", 1, "Give back"), { ok: false, error: "Give back 1." });
  });
});

describe("what a rest gives back (7.2)", () => {
  test("a Short Rest names one of each that comes back one at a time, and all of each that comes back whole", () => {
    assert.equal(restBackText([rage, focus], "short"), "A Short Rest also gives back one Rage and all Focus Points.");
    assert.equal(restBackText([rage, focus, surge], "short"), "A Short Rest also gives back one Rage, all Focus Points and Action Surge.");
    assert.equal(restBackText([{ ...surge, max: 2 }], "short"), "A Short Rest also gives back all Action Surge.");
  });

  test("only what is spent, and a Short Rest none that wait for a Long one", () => {
    assert.equal(restBackText([hands, { ...rage, used: 0 }], "short"), null);
    assert.equal(restBackText([{ ...hands, used: 5 }], "short"), null, "Lay on Hands waits for a Long Rest");
    assert.equal(restBackText(undefined, "short"), null);
    assert.equal(restBackText([], "long"), null);
  });

  test("a Long Rest names everything spent", () => {
    assert.equal(restBackText([rage, focus, hands, surge], "long"), "A Long Rest also gives back Rage, Focus Points and Action Surge.");
    assert.equal(restBackText([hands], "long"), null);
    assert.equal(joinWords(["Rage"]), "Rage");
    assert.equal(joinWords([]), "");
  });
});

describe("adding from a class (7.1)", () => {
  test("a new pick starts at the character's level with no class, or 1 with no level", () => {
    assert.deepEqual(startPick(undefined, 7), { classId: null, classLevel: 7, ticks: [], modifiers: {} });
    assert.deepEqual(startPick([], undefined), { classId: null, classLevel: 1, ticks: [], modifiers: {} });
  });

  test("a character with presets starts on their class, at the class level they were read at", () => {
    const draft = startPick([{ id: "o", name: "Own", max: 1, used: 0, reset: "long" }, rage], 9);
    assert.equal(draft.classId, "barbarian");
    assert.equal(draft.classLevel, 5);
    assert.deepEqual(draft.ticks, [], "Rage is already there");
  });

  test("a class ticks its own presets at the level, never a subclass's", () => {
    const draft = pickClass(startPick(undefined, 15), "barbarian", undefined, 15);
    assert.deepEqual(draft.ticks, ["barbarian-rage", "barbarian-persistent-rage"]);
    assert.deepEqual(pickClass(startPick(undefined, 3), "ranger", undefined, 3).ticks, []);
    assert.deepEqual(defaultTicks("warlock", 14, undefined), ["warlock-magical-cunning"]);
  });

  test("a new level keeps the player's ticks that start by then and ticks what it adds", () => {
    let draft = pickClass(startPick(undefined, 1), "barbarian", undefined, 1);
    assert.deepEqual(draft.ticks, ["barbarian-rage"]);
    draft = tick(draft, "barbarian-rage", false);
    draft = pickLevel(draft, 15, undefined);
    assert.deepEqual(draft.ticks, ["barbarian-persistent-rage"], "Rage stays unticked, Persistent Rage comes");
    draft = tick(draft, "barbarian-intimidating-presence", true);
    draft = pickLevel(draft, 14, undefined);
    assert.deepEqual(draft.ticks, ["barbarian-intimidating-presence"], "Persistent Rage starts at 15");
    assert.equal(pickLevel({ classId: null, classLevel: 1, ticks: [], modifiers: {} }, 4, undefined).classLevel, 4);
  });

  test("the rows: each preset by then with its count, its rest, and what the character has", () => {
    const draft = pickClass(startPick(undefined, 6), "barbarian", [rage], 6);
    const rows = pickRows({ ...draft, classLevel: 14 }, [rage], {});
    assert.deepEqual(
      rows.map((r) => [r.preset.id, r.count, r.reset, r.have?.id ?? null]),
      [
        ["barbarian-rage", 5, "shortOne", "rage"],
        ["barbarian-intimidating-presence", 1, "long", null],
      ],
    );
    assert.deepEqual(pickRows(startPick(undefined, 3), [], {}), [], "no class, no rows");
  });

  test("a count from a modifier reads the stat block, else asks for it", () => {
    const draft = pickClass(startPick(undefined, 5), "bard", undefined, 5);
    const [asked] = pickRows(draft, undefined, {});
    assert.equal(asked?.asks, "cha");
    assert.equal(asked?.count, null);
    const [typed] = pickRows({ ...draft, modifiers: { cha: 2 } }, undefined, {});
    assert.equal(typed?.count, 2);
    const [read] = pickRows({ ...draft, modifiers: { cha: 2 } }, undefined, blockModifiers({ abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 8, cha: 18 } }));
    assert.equal(read?.count, 4, "the block wins over a typed modifier");
    assert.equal(read?.asks, undefined);
    assert.deepEqual(blockModifiers(undefined), {});
    assert.deepEqual(blockModifiers({ abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 7, cha: 13 } }), { wis: -2, cha: 1 });
  });

  test("what each row says", () => {
    const at = (draft: PickDraft, have: ClassResource[] = [], block = {}) => pickRows(draft, have, block).map((r) => pickHelp(r, "add"));
    assert.deepEqual(at(pickClass(startPick(undefined, 14), "barbarian", undefined, 14)), [
      "5 uses. One back on a Short Rest, all on a Long Rest.",
      "Path of the Berserker. 1 use. Back on a Long Rest.",
    ]);
    assert.deepEqual(at(pickClass(startPick(undefined, 4), "paladin", undefined, 4)), ["A pool of 20. Back on a Long Rest.", "2 uses. One back on a Short Rest, all on a Long Rest."]);
    assert.deepEqual(at(pickClass(startPick(undefined, 5), "bard", undefined, 5)), ["Your Charisma modifier, at least 1. Back on a Short or Long Rest."]);
    assert.deepEqual(at(pickClass(startPick(undefined, 5), "bard", undefined, 5), [], { cha: 3 }), ["3 uses, from the stat block's Charisma. Back on a Short or Long Rest."]);
    assert.deepEqual(at(pickClass(startPick(undefined, 5), "barbarian", [rage], 5), [rage]), ["Already added."]);
    assert.equal(countWords(1, false), "1 use");
  });

  test("Add puts the ticked presets the character lacks at the end, each with its class level and the character's level", () => {
    const draft = pickLevel(pickClass(startPick([rage], 15), "barbarian", [rage], 15), 15, [rage]);
    const out = addOutcome(draft, { resources: [rage], block: {}, characterLevel: 15, newId: ids() });
    assert.ok(out.ok);
    assert.deepEqual(out.resources, [
      { id: "rage", name: "Rage", max: 3, reset: "shortOne", preset: "barbarian-rage", level: 5, atLevel: 5 },
      { id: "id-1", name: "Persistent Rage", max: 1, reset: "long", preset: "barbarian-persistent-rage", level: 15, atLevel: 15 },
    ]);
    sendable(out.resources);
  });

  test("Add with a typed modifier, and without one", () => {
    const draft = pickClass(startPick(undefined, 6), "warlock", undefined, 6);
    const luck = tick(draft, "warlock-dark-ones-own-luck", true);
    assert.deepEqual(addOutcome(luck, { resources: [], block: {}, characterLevel: 6, newId: ids() }), { ok: false, error: "Fill in the Charisma modifier for Dark One’s Own Luck." });
    const out = addOutcome({ ...luck, modifiers: { cha: 4 } }, { resources: [], block: {}, characterLevel: 6, newId: ids() });
    assert.ok(out.ok);
    assert.deepEqual(
      out.resources.map((r) => [r.name, r.max]),
      [
        ["Magical Cunning", 1],
        ["Dark One’s Own Luck", 4],
      ],
    );
    sendable(out.resources);
  });

  test("Add refuses no class, nothing ticked, and a list past the limit", () => {
    const ctx = { resources: [], block: {}, characterLevel: 5, newId: ids() };
    assert.deepEqual(addOutcome(startPick(undefined, 5), ctx), { ok: false, error: "Choose a class first." });
    assert.deepEqual(addOutcome(pickClass(startPick(undefined, 3), "rogue", undefined, 3), ctx), { ok: false, error: "Tick a resource to add." });
    const many: ClassResource[] = Array.from({ length: LIMITS.resourcesPerCharacter - 1 }, (_, i) => ({ id: `o${i}`, name: `Own ${i}`, max: 1, used: 0, reset: "long" }));
    const draft = pickClass(startPick(undefined, 2), "monk", many, 2);
    assert.equal(draft.ticks.length, 2);
    assert.deepEqual(addOutcome(draft, { ...ctx, resources: many }), { ok: false, error: `A character holds at most ${LIMITS.resourcesPerCharacter} class resources. Untick 1 or remove one first.` });
    assert.ok(addOutcome(tick(draft, "monk-focus-points", false), { ...ctx, resources: many }).ok, "exactly at the limit");
  });

  test("a preset added meanwhile on another device is not added twice", () => {
    const draft = pickClass(startPick(undefined, 5), "barbarian", undefined, 5);
    assert.deepEqual(draft.ticks, ["barbarian-rage"], "ticked while Thorn had none");
    assert.deepEqual(addOutcome(draft, { resources: [rage], block: {}, characterLevel: 5, newId: ids() }), { ok: false, error: "Tick a resource to add." });
  });

  test("a class with nothing yet names its first level", () => {
    assert.equal(firstLevel("ranger"), 10);
    assert.equal(firstLevel("rogue"), 20);
    assert.equal(firstLevel("barbarian"), 1);
  });
});

describe("updating a class after a level rose (7.1)", () => {
  test("it starts at the guessed level, with what that level adds ticked", () => {
    const draft = startUpdate([rage], { classId: "barbarian", classLevel: 5, guess: 15 });
    assert.deepEqual(draft, { classId: "barbarian", classLevel: 15, ticks: ["barbarian-persistent-rage"], modifiers: {} });
    assert.deepEqual(startUpdate([rage], { classId: "barbarian", classLevel: 5, guess: 6 }).ticks, []);
  });

  test("what an update's rows say", () => {
    const draft = startUpdate([rage, { ...surge, edited: true }], { classId: "barbarian", classLevel: 5, guess: 6 });
    const help = (d: PickDraft, have: ClassResource[]) => pickRows(d, have, {}).map((r) => pickHelp(r, "update"));
    assert.deepEqual(help(draft, [rage]), ["Goes from 3 to 4."]);
    assert.deepEqual(help({ ...draft, classLevel: 5 }, [rage]), ["Stays at 3."]);
    assert.deepEqual(help(draft, [{ ...rage, edited: true }]), ["Stays at 3, typed by hand."]);
    const bard: ClassResource = { id: "b", name: "Bardic Inspiration", max: 3, used: 0, reset: "long", preset: "bard-bardic-inspiration", level: 4, atLevel: 4 };
    assert.deepEqual(help(startUpdate([bard], { classId: "bard", classLevel: 4, guess: 5 }), [bard]), ["Stays at 3."], "no modifier to read again");
  });

  test("Update reads the class again, adds what is ticked, and stamps the character's level", () => {
    const draft = startUpdate([rage, focus], { classId: "barbarian", classLevel: 5, guess: 15 });
    const out = updateOutcome(draft, { resources: [rage, focus], block: {}, characterLevel: 15, newId: ids() });
    assert.ok(out.ok);
    assert.deepEqual(out.resources, [
      { id: "rage", name: "Rage", max: 5, reset: "shortOne", preset: "barbarian-rage", level: 15, atLevel: 15 },
      { id: "focus", name: "Focus Points", max: 5, reset: "short", pool: true, preset: "monk-focus-points", level: 5, atLevel: 5 },
      { id: "id-1", name: "Persistent Rage", max: 1, reset: "long", preset: "barbarian-persistent-rage", level: 15, atLevel: 15 },
    ]);
    sendable(out.resources);
  });

  test("Update reads a modifier from the block, or as typed", () => {
    const bard: ClassResource = { id: "b", name: "Bardic Inspiration", max: 3, used: 0, reset: "long", preset: "bard-bardic-inspiration", level: 4, atLevel: 4 };
    const draft = startUpdate([bard], { classId: "bard", classLevel: 4, guess: 5 });
    const typed = updateOutcome({ ...draft, modifiers: { cha: 4 } }, { resources: [bard], block: {}, characterLevel: 5, newId: ids() });
    assert.ok(typed.ok);
    assert.deepEqual([typed.resources[0]?.max, typed.resources[0]?.reset], [4, "short"]);
    const read = updateOutcome({ ...draft, modifiers: { cha: 4 } }, { resources: [bard], block: { cha: 5 }, characterLevel: 5, newId: ids() });
    assert.ok(read.ok);
    assert.equal(read.resources[0]?.max, 5);
  });

  test("Update past the limit is refused", () => {
    const many: ClassResource[] = Array.from({ length: LIMITS.resourcesPerCharacter - 1 }, (_, i) => ({ id: `o${i}`, name: `Own ${i}`, max: 1, used: 0, reset: "long" }));
    const draft = startUpdate([...many, rage], { classId: "barbarian", classLevel: 5, guess: 15 });
    assert.deepEqual(updateOutcome(draft, { resources: [...many, rage], block: {}, characterLevel: 15, newId: ids() }), {
      ok: false,
      error: `A character holds at most ${LIMITS.resourcesPerCharacter} class resources. Untick 1 or remove one first.`,
    });
  });
});

describe("one of the player's own, and an edit (7.1)", () => {
  test("a new one goes at the end with no preset", () => {
    const out = ownOutcome({ name: "  Superiority Dice ", count: "4", reset: "short", pool: false }, { resources: [rage], newId: ids() });
    assert.ok(out.ok);
    assert.deepEqual(out.resources[1], { id: "id-1", name: "Superiority Dice", max: 4, reset: "short" });
    sendable(out.resources);
    const pool = ownOutcome({ name: "Ki", count: "150", reset: "short", pool: true }, { resources: [], newId: ids() });
    assert.ok(pool.ok);
    assert.deepEqual(pool.resources[0], { id: "id-1", name: "Ki", max: 150, reset: "short", pool: true });
    sendable(pool.resources);
  });

  test("its name and count must fit", () => {
    const own = (draft: Partial<typeof EMPTY_OWN>) => ownOutcome({ ...EMPTY_OWN, name: "Luck", count: "3", ...draft }, { resources: [], newId: ids() });
    assert.deepEqual(own({ name: "  " }), { ok: false, error: "Give it a name." });
    assert.deepEqual(own({ name: "x".repeat(41) }), { ok: false, error: "A name is at most 40 characters." });
    assert.ok(own({ name: "x".repeat(40) }).ok);
    assert.deepEqual(own({ name: "Luck\u202e" }), { ok: false, error: "A name holds letters, numbers and punctuation only." });
    assert.deepEqual(own({ name: "Luck\ud800" }), { ok: false, error: "A name holds letters, numbers and punctuation only." });
    assert.deepEqual(own({ count: "" }), { ok: false, error: "A count is 1 to 99." });
    assert.deepEqual(own({ count: "100" }), { ok: false, error: "A count is 1 to 99." });
    assert.deepEqual(own({ count: "0" }), { ok: false, error: "A count is 1 to 99." });
    assert.deepEqual(own({ count: "1.5" }), { ok: false, error: "A count is 1 to 99." });
    assert.ok(own({ count: "99" }).ok);
    assert.deepEqual(own({ count: "201", pool: true }), { ok: false, error: "An amount is 1 to 200." });
    assert.ok(own({ count: "200", pool: true }).ok);
  });

  test("a full list takes no more", () => {
    const many: ClassResource[] = Array.from({ length: LIMITS.resourcesPerCharacter }, (_, i) => ({ id: `o${i}`, name: `Own ${i}`, max: 1, used: 0, reset: "long" }));
    assert.deepEqual(ownOutcome({ ...EMPTY_OWN, name: "Luck", count: "1" }, { resources: many, newId: ids() }), { ok: false, error: `A character holds at most ${LIMITS.resourcesPerCharacter} class resources. Remove one first.` });
  });

  test("an edit changes it in place, and a new count marks it typed by hand", () => {
    assert.deepEqual(editDraft(focus), { name: "Focus Points", count: "5", reset: "short", pool: true });
    const renamed = editOutcome({ ...editDraft(rage), name: "Big Rage", reset: "long" }, { resources: [rage, focus], id: "rage" });
    assert.ok(renamed.ok);
    assert.deepEqual(renamed.resources[0], { id: "rage", name: "Big Rage", max: 3, reset: "long", preset: "barbarian-rage", level: 5, atLevel: 5 });
    const counted = editOutcome({ ...editDraft(rage), count: "4" }, { resources: [rage, focus], id: "rage" });
    assert.ok(counted.ok);
    assert.deepEqual(counted.resources[0], { id: "rage", name: "Rage", max: 4, reset: "shortOne", preset: "barbarian-rage", level: 5, atLevel: 5, edited: true });
    assert.deepEqual(counted.resources[1], { id: "focus", name: "Focus Points", max: 5, reset: "short", pool: true, preset: "monk-focus-points", level: 5, atLevel: 5 });
    sendable(counted.resources);
    const kept = editOutcome({ ...editDraft({ ...rage, edited: true }), name: "Rage" }, { resources: [{ ...rage, edited: true }], id: "rage" });
    assert.ok(kept.ok);
    assert.equal(kept.resources[0]?.edited, true, "a count typed earlier stays typed");
  });

  test("an edit turns a pool on and off", () => {
    const off = editOutcome({ ...editDraft(focus), pool: false }, { resources: [focus], id: "focus" });
    assert.ok(off.ok);
    assert.equal(off.resources[0]?.pool, undefined);
    const on = editOutcome({ ...editDraft(rage), pool: true }, { resources: [rage], id: "rage" });
    assert.ok(on.ok);
    assert.equal(on.resources[0]?.pool, true);
    const big = { ...hands, max: 150 };
    assert.deepEqual(editOutcome({ ...editDraft(big), pool: false }, { resources: [big], id: "hands" }), { ok: false, error: "A count is 1 to 99." }, "150 fits a pool, not a count");
  });

  test("unticking a preset's Spend an amount marks it typed by hand, so Lay on Hands at Paladin 19 keeps 95 through an update to 20 (CC-AC-ASTRA-05)", () => {
    const hands19: ClassResource = { ...fromPreset(presetById("paladin-lay-on-hands")!, { id: "hands", classLevel: 19, characterLevel: 19 })!, used: 0 };
    const edited = editOutcome({ ...editDraft(hands19), pool: false }, { resources: [hands19], id: "hands" });
    assert.ok(edited.ok);
    assert.deepEqual(edited.resources[0], { id: "hands", name: "Lay on Hands", max: 95, reset: "long", preset: "paladin-lay-on-hands", level: 19, atLevel: 19, edited: true });
    const stored = edited.resources.map((r) => ({ ...r, used: 0 }));
    const updated = updateOutcome(startUpdate(stored, { classId: "paladin", classLevel: 19, guess: 20 }), { resources: stored, block: {}, characterLevel: 20, newId: ids() });
    assert.ok(updated.ok, updated.ok ? "" : updated.error);
    assert.deepEqual(updated.resources[0], { id: "hands", name: "Lay on Hands", max: 95, reset: "long", preset: "paladin-lay-on-hands", level: 20, atLevel: 20, edited: true });
    sendable(updated.resources);
    const back = editOutcome({ ...editDraft(hands19), pool: true }, { resources: [hands19], id: "hands" });
    assert.ok(back.ok);
    assert.equal(back.resources[0]?.edited, undefined, "the preset's own pool and count are not typed by hand");
    const own = editOutcome({ ...editDraft({ id: "ki", name: "Ki", max: 5, used: 0, reset: "short" }), pool: true }, { resources: [{ id: "ki", name: "Ki", max: 5, used: 0, reset: "short" }], id: "ki" });
    assert.ok(own.ok);
    assert.equal(own.resources[0]?.edited, undefined, "one of the player's own has no preset to differ from");
  });

  test("Add, Update and Edit say what the server would refuse in place of sending it", () => {
    // A count past 99 with no pool, as a list from before the pool rule above could hold.
    const old: ClassResource = { id: "old", name: "Lay on Hands", max: 95, used: 0, reset: "long", preset: "paladin-lay-on-hands", level: 19, atLevel: 19 };
    const refused = { ok: false, error: "Lay on Hands: a count is at most 99, a pool's 200." };
    assert.deepEqual(updateOutcome(startUpdate([old], { classId: "paladin", classLevel: 19, guess: 20 }), { resources: [old], block: {}, characterLevel: 20, newId: ids() }), refused);
    const past: ClassResource = { ...old, max: 120 };
    assert.deepEqual(addOutcome(pickClass(startPick([past], 5), "barbarian", [past], 5), { resources: [past], block: {}, characterLevel: 5, newId: ids() }), refused);
    assert.deepEqual(ownOutcome({ name: "Luck", count: "3", reset: "long", pool: false }, { resources: [past], newId: ids() }), refused);
    assert.deepEqual(editOutcome({ ...editDraft(rage), name: "Big Rage" }, { resources: [rage, past], id: "rage" }), refused);
    assert.deepEqual(removeOutcome([rage, past], "rage"), refused, "Remove too, of another one");
    assert.deepEqual(removeOutcome([rage, past], "old"), { ok: true, resources: [asInputs([rage])[0]] }, "removing the one the server would refuse goes");
  });

  test("an edit of one removed meanwhile says so, and Remove leaves the rest", () => {
    assert.deepEqual(editOutcome(editDraft(rage), { resources: [focus], id: "rage" }), { ok: false, error: "It was removed meanwhile." });
    const left = removeOutcome([rage, focus], "rage");
    assert.ok(left.ok);
    assert.deepEqual(
      left.resources.map((r) => r.id),
      ["focus"],
    );
    assert.deepEqual(removeOutcome([rage], "rage"), { ok: true, resources: [] }, "an empty list removes them all");
  });

  test("every preset the data has is found by its id", () => {
    for (const r of [rage, focus, surge, hands]) assert.ok(presetById(r.preset), r.preset);
  });
});
