import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Character, ClassLevel } from "#shared/model.ts";
import { restBackText, partyRestBackText, startPick } from "../resources/logic.ts";
import { usesCount, usesPresence } from "../combat/logic.ts";
import { blockLevel, offerGone, offersAfterSend } from "../dice/cast/cast.ts";
import {
  classesLine,
  CON_RANGE,
  conChoice,
  conSource,
  dieGuard,
  dieRows,
  foldedBack,
  foldedUse,
  hitDiceLine,
  leftByLevel,
  levelMismatch,
  lowering,
  newRow,
  offerPools,
  pactStart,
  preview,
  rolledText,
  rollLabel,
  rollText,
  rowsClasses,
  savePatch,
  slotCount,
  slotLevels,
  slotUseLabel,
  spendOff,
  startRows,
  typedOutcome,
  type ClassRow,
} from "./logic.ts";

/** Bree with these classes and spent counts, the rest as a test character needs. */
function bree(classes: ClassLevel[] | undefined, spent?: Character["spent"], extra: Partial<Character> = {}): Character {
  return { id: "bree", rev: 1, ownerIds: ["p1"], name: "Bree", size: "medium", actor: {} as Character["actor"], ...(classes ? { classes } : {}), ...(spent ? { spent } : {}), ...extra };
}

let n = 0;
const key = () => `k${(n += 1)}`;
const row = (id: ClassRow["id"], level: number, more: Partial<ClassRow> = {}): ClassRow => ({ key: key(), id, level, third: false, die: 8, ...more });

describe("spell slot rows", () => {
  test("levels the character has, what is left, and Pact Magic apart", () => {
    const { levels, pact } = slotLevels(bree([{ id: "wizard", level: 5 }, { id: "warlock", level: 5 }], { slots: [1, 0, 2, 0, 0, 0, 0, 0, 0], pact: 1 }));
    assert.deepEqual(levels, [{ level: 1, max: 4, left: 3 }, { level: 2, max: 3, left: 3 }, { level: 3, max: 2, left: 0 }]);
    assert.deepEqual(pact, { slots: 2, level: 3, left: 1 });
    assert.equal(leftByLevel(levels), "Left by level: 3, 3, 0");
    assert.equal(slotUseLabel(levels[0]!), "Use a level 1 spell slot, 3 of 4 left");
    assert.deepEqual(foldedUse(levels[2]!), { text: "Level 3, 0 left", label: "Use a level 3 spell slot, 0 left" });
    assert.deepEqual(foldedBack(levels[2]!).text, "Level 3, 2 spent");
  });
  test("the turn card counts the slot group as 1 and Pact Magic as 1", () => {
    assert.equal(slotCount([{ id: "wizard", level: 3 }]), 1);
    assert.equal(slotCount([{ id: "wizard", level: 5 }, { id: "warlock", level: 5 }]), 2);
    assert.equal(slotCount([{ id: "fighter", level: 5 }]), 0);
    assert.equal(slotCount(undefined), 0);
    assert.equal(usesCount([], undefined, slotCount([{ id: "wizard", level: 3 }])), 1);
    assert.equal(usesPresence({ actor: undefined, resources: undefined, slots: 1, uses: [], loading: false, record: null }), "yes");
    assert.equal(usesPresence({ actor: undefined, resources: undefined, slots: 0, uses: [], loading: false, record: null }), "no");
  });
});

describe("the slot offer of a sent cast ask", () => {
  const wizWar = bree([{ id: "wizard", level: 5 }, { id: "warlock", level: 5 }]);
  test("ordinary slots at exactly the casting level, Pact only at its own level", () => {
    assert.deepEqual(offerPools(wizWar, 1).map((p) => p.text), ["Use a level 1 spell slot"]);
    assert.deepEqual(offerPools(wizWar, 3).map((p) => p.text), ["Use a level 3 spell slot", "Use a Pact Magic slot (cast at level 3)"]);
    const big = bree([{ id: "wizard", level: 9 }, { id: "warlock", level: 5 }]);
    assert.deepEqual(offerPools(big, 5).map((p) => p.kind), ["slot"]);
    assert.deepEqual(offerPools(big, 3).map((p) => p.kind), ["slot", "pact"]);
    assert.deepEqual(offerPools(bree([{ id: "warlock", level: 5 }]), 3).map((p) => p.kind), ["pact"]);
    assert.deepEqual(offerPools(bree([{ id: "warlock", level: 5 }]), 1), []);
  });
  test("each pool is off with its reason when none is left", () => {
    const pools = offerPools(bree([{ id: "wizard", level: 5 }, { id: "warlock", level: 5 }], { slots: [0, 0, 2, 0, 0, 0, 0, 0, 0], pact: 2 }), 3);
    assert.deepEqual(pools.map((p) => p.off), ["No level 3 spell slots left.", "No Pact Magic slots left."]);
    assert.deepEqual(pools[1]!.op, { t: "actor.use", target: { characterId: "bree" }, use: { kind: "pact" } });
  });
  test("a Warlock 5's level 1 spell starts at the Pact level, a multiclass caster's at its own", () => {
    assert.equal(pactStart([{ id: "warlock", level: 5 }], 1), 3);
    assert.equal(pactStart([{ id: "warlock", level: 5 }], 4), null);
    assert.equal(pactStart([{ id: "warlock", level: 5 }, { id: "wizard", level: 1 }], 1), null);
    assert.equal(pactStart([{ id: "wizard", level: 5 }], 1), null);
    assert.deepEqual(blockLevel({ level: 1, rowSlot: null, picked: undefined, start: 3 }), { min: 1, value: 3, own: true });
    assert.deepEqual(blockLevel({ level: 1, rowSlot: null, picked: 2, start: 3 }), { min: 1, value: 2, own: true });
  });
  test("a sent ask sets the offer, another from that spell replaces it, one with no pool ends it", () => {
    let offers = offersAfterSend({}, { key: "c:bree", spell: "Fireball", characterId: "bree", level: 3, pools: 1 });
    assert.deepEqual(Object.values(offers), [{ key: "c:bree", spell: "Fireball", characterId: "bree", level: 3 }]);
    offers = offersAfterSend(offers, { key: "c:bree", spell: "Fireball", characterId: "bree", level: 4, pools: 1 });
    assert.deepEqual(Object.values(offers).map((o) => o.level), [4]);
    offers = offersAfterSend(offers, { key: "c:bree", spell: "Hold Person", characterId: "bree", level: 2, pools: 1 });
    assert.equal(Object.keys(offers).length, 2);
    assert.equal(Object.keys(offersAfterSend(offers, { key: "c:bree", spell: "fireball", characterId: "bree", level: 9, pools: 0 })).length, 1);
    assert.equal(Object.keys(offerGone(offers, "c:bree", "Hold Person")).length, 1);
  });
});

describe("Hit Point Dice", () => {
  const thorn = bree([{ id: "paladin", level: 3 }, { id: "fighter", level: 2 }, { id: "cleric", level: 1 }], { dice: { d10: 2 } }, { name: "Thorn" });
  test("rows largest first and the count line", () => {
    assert.deepEqual(dieRows(thorn), [{ die: 10, max: 5, left: 3 }, { die: 8, max: 1, left: 1 }]);
    assert.equal(hitDiceLine(dieRows(thorn)), "Hit Point Dice: 3 of 5 d10, 1 of 1 d8");
    assert.equal(hitDiceLine(dieRows(bree(undefined))), null);
  });
  test("Roll's words and name, and why it is off", () => {
    const [d10] = dieRows(thorn);
    assert.equal(rollText(10, 2), "Roll d10 + 2");
    assert.equal(rollText(10, -1), "Roll d10 - 1");
    assert.equal(rollLabel(d10!, 2), "Roll a d10 Hit Point Die plus 2, 3 of 5 left");
    assert.equal(spendOff(d10!, { cur: 20, max: 20 }, "Thorn"), "Thorn's HP is full.");
    assert.equal(spendOff({ die: 10, max: 5, left: 0 }, { cur: 2, max: 20 }, "Thorn"), "No d10 Hit Point Dice left.");
    assert.equal(spendOff(d10!, { cur: 2, max: 20 }, "Thorn"), null);
  });
  test("a landed roll's words, at least 1", () => {
    assert.equal(rolledText(7, 2), "Rolled 7 + 2: 9 HP back.");
    assert.equal(rolledText(1, -2), "Rolled 1 - 2: 1 HP back, at least 1.");
  });
  test("a typed roll is 1 to 100000", () => {
    assert.deepEqual(typedOutcome(" 9 "), { ok: true, heal: 9 });
    for (const t of ["0", "", "x", "100001"]) assert.equal(typedOutcome(t).ok, false, t);
  });
  test("Constitution: the numbers', busy while they load, off if they fail, and a field only with no block and no shape", () => {
    assert.deepEqual(conSource({ shaped: false, hasBlock: true, numbersCon: 2, loading: false, failed: false }), { kind: "numbers", con: 2 });
    assert.deepEqual(conSource({ shaped: true, hasBlock: false, numbersCon: undefined, loading: true, failed: false }), { kind: "loading" });
    assert.deepEqual(conSource({ shaped: true, hasBlock: false, numbersCon: undefined, loading: false, failed: true }), { kind: "failed" });
    assert.deepEqual(conSource({ shaped: false, hasBlock: false, numbersCon: undefined, loading: false, failed: false }), { kind: "field" });
    // A shaped character never gets the field, even with nothing loaded.
    assert.notEqual(conSource({ shaped: true, hasBlock: false, numbersCon: undefined, loading: false, failed: false }).kind, "field");
  });
  test("the Constitution field: empty is +0, a modifier is itself, and anything else holds Roll with the range", () => {
    assert.deepEqual(conChoice(""), { ok: true, con: 0 });
    assert.deepEqual(conChoice("  "), { ok: true, con: 0 });
    assert.deepEqual(conChoice("+3"), { ok: true, con: 3 });
    assert.deepEqual(conChoice("-5"), { ok: true, con: -5 });
    for (const t of ["11", "-6", "x", "2.5", "+"]) assert.deepEqual(conChoice(t), { ok: false, error: CON_RANGE }, t);
  });
  test("one guard for Roll, typed Spend and Restore: with answers held back, no second die goes before the first answer", () => {
    // A fake server that answers only when told, as a slow connection would.
    const pending: (() => void)[] = [];
    const sent: string[] = [];
    const heldSeen: boolean[] = [];
    const guard = dieGuard((held) => heldSeen.push(held));
    const tap = (what: string) =>
      guard.run((done) => {
        sent.push(what);
        pending.push(done);
        return true;
      });
    assert.equal(tap("roll d10"), true);
    // Every other path waits: another Roll, a typed Spend, a Restore, and another row's.
    for (const what of ["roll d10", "spend d10 4", "restore d10", "roll d8"]) assert.equal(tap(what), false, what);
    assert.deepEqual(sent, ["roll d10"]);
    assert.equal(guard.held(), true);
    pending.shift()!();
    assert.equal(guard.held(), false);
    assert.equal(tap("spend d8 4"), true);
    assert.equal(tap("roll d10"), false);
    pending.shift()!();
    // A late second answer for one done changes nothing.
    assert.equal(tap("restore d8"), true);
    pending[0]!();
    pending[0]!();
    assert.equal(guard.held(), false);
    assert.deepEqual(sent, ["roll d10", "spend d8 4", "restore d8"]);
    assert.deepEqual(heldSeen, [true, false, true, false, true, false]);
    // A send that sent nothing frees the guard at once.
    assert.equal(guard.run(() => false), true);
    assert.equal(guard.held(), false);
  });
});

describe("the Classes sheet", () => {
  test("starts from the classes, else each preset's class at its highest level read, else none", () => {
    assert.deepEqual(startRows(bree([{ id: "wizard", level: 5 }, { id: "other", level: 2, die: 10 }]), key).map((r) => [r.id, r.level, r.die]), [["wizard", 5, 8], ["other", 2, 10]]);
    const resources = [{ id: "r1", name: "Rage", max: 3, used: 0, reset: "long" as const, preset: "barbarian-rage", level: 5 }, { id: "r2", name: "Rage", max: 2, used: 0, reset: "long" as const, preset: "barbarian-rage", level: 3 }];
    assert.deepEqual(startRows(bree(undefined, undefined, { resources }), key).map((r) => [r.id, r.level]), [["barbarian", 5]]);
    assert.deepEqual(startRows(bree(undefined), key), []);
  });
  test("a new row takes the first class no row picked", () => {
    assert.equal(newRow([row("barbarian", 1)], "x")!.id, "bard");
  });
  test("the preview, the level and the lowering line", () => {
    const rows = [row("fighter", 5), row("paladin", 3), row("cleric", 1)];
    assert.deepEqual(preview(rows, 6), { gives: "Spell slots: 4, 2. Hit Point Dice: 8 d10 and 1 d8.", total: "Level 9 in all.", sets: "Saving sets the character's level to 9.", over: null });
    assert.deepEqual(preview([row("warlock", 5), row("wizard", 1)], 6).gives, "Spell slots: 2. Pact Magic: 2 at level 3. Hit Point Dice: 5 d8 and 1 d6.");
    assert.equal(preview([row("wizard", 15), row("cleric", 8)], 6).over, "The classes add up to 23. A character's level is at most 20.");
    assert.equal(savePatch([row("wizard", 15), row("cleric", 8)], 6), null);
    assert.deepEqual(lowering("Bree", 8, [row("wizard", 3)]), { line: "Saving lowers Bree's level from 8 to 3, and with it the Proficiency Bonus.", button: "Lower to level 3 and save" });
    assert.equal(lowering("Bree", 3, [row("wizard", 3)]), null);
  });
  test("saving sends the classes and their sum, and no classes keeps the level", () => {
    assert.deepEqual(savePatch([row("wizard", 5), row("cleric", 1)], 5), { classes: [{ id: "wizard", level: 5 }, { id: "cleric", level: 1 }], level: 6 });
    assert.deepEqual(savePatch([row("wizard", 6)], 6), { classes: [{ id: "wizard", level: 6 }] });
    assert.deepEqual(savePatch([], 6), { classes: [] });
  });
  test("its subclass casts spells only from level 3, and only for a Fighter or Rogue", () => {
    assert.deepEqual(rowsClasses([row("fighter", 2, { third: true }), row("rogue", 3, { third: true }), row("wizard", 1, { third: true })]), [{ id: "fighter", level: 2 }, { id: "rogue", level: 3, third: true }, { id: "wizard", level: 1 }]);
  });
  test("the Classes line and the level line", () => {
    assert.equal(classesLine([{ id: "wizard", level: 5 }, { id: "cleric", level: 1 }]), "Classes: Wizard 5, Cleric 1");
    assert.equal(classesLine([{ id: "other", level: 3, die: 8 }]), "Classes: Other class 3 (d8)");
    assert.equal(levelMismatch(bree([{ id: "wizard", level: 5 }], undefined, { level: 6 })), "Your classes add up to level 5, and your level is 6.");
    assert.equal(levelMismatch(bree([{ id: "wizard", level: 6 }], undefined, { level: 6 })), null);
  });
  test("Add a class resource starts at the first SRD class in the classes, at its level", () => {
    const pick = startPick(undefined, 6, [{ id: "other", level: 1, die: 8 }, { id: "barbarian", level: 5 }]);
    assert.deepEqual([pick.classId, pick.classLevel], ["barbarian", 5]);
  });
});

describe("rest words", () => {
  const rage = { id: "r1", name: "Rage", max: 3, used: 1, reset: "shortOne" as const };
  test("a Long Rest names what is spent, slots and dice counted", () => {
    assert.equal(restBackText([rage], "long", { slots: [2, 1, 0, 0, 0, 0, 0, 0, 0], dice: { d10: 2 } }), "A Long Rest also restores Rage, 3 spell slots and 2 Hit Point Dice.");
    assert.equal(restBackText([], "long", { slots: [1, 0, 0, 0, 0, 0, 0, 0, 0], dice: { d10: 1 } }), "A Long Rest also restores 1 spell slot and 1 Hit Point Die.");
  });
  test("a Short Rest brings back Pact Magic, never slots or dice", () => {
    assert.equal(restBackText([rage], "short", { slots: [2, 0, 0, 0, 0, 0, 0, 0, 0], pact: 2, dice: { d8: 1 } }), "A Short Rest also restores 2 Pact Magic slots and one Rage.");
    assert.equal(restBackText([], "short", { slots: [2, 0, 0, 0, 0, 0, 0, 0, 0] }), null);
  });
  test("the party card names each kind any of them has spent", () => {
    assert.equal(partyRestBackText([{ resources: [rage] }, { spent: { slots: [1, 0, 0, 0, 0, 0, 0, 0, 0], dice: { d6: 1 } } }]), "It also restores every class resource, spell slot and Hit Point Die.");
    assert.equal(partyRestBackText([{ resources: [rage] }]), "It also restores every class resource.");
    assert.equal(partyRestBackText([{}]), null);
  });
});
