import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Character, LogEvent, RoomState } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { actor, apply, character, DM, env, P1, refused, room, token } from "../testutil.ts";

/** Bree, a Wizard 5 and Warlock 5 played by P1, hurt to 10 of 30, with a token on s1. */
function table(overrides: Partial<Character> = {}): RoomState {
  return room({
    characters: { bree: character("bree", { name: "Bree", classes: [{ id: "wizard", level: 5 }, { id: "warlock", level: 5 }], actor: actor({ hp: { cur: 10, max: 30, temp: 0 } }), ...overrides }) },
    tokens: { t1: token("t1", { kind: "pc", actor: { ref: "bree" }, ownerIds: ["p1"] }) },
  });
}
const bree = (s: RoomState) => s.characters.bree!;
const use = (u: Extract<Op, { t: "actor.use" }>["use"], back?: true): Op => ({ t: "actor.use", target: { characterId: "bree" }, use: u, ...(back ? { back } : {}) });
const lines = (before: RoomState, after: RoomState): LogEvent[] => {
  const was = new Set(before.log.map((e) => e.id));
  return after.log.filter((e) => !was.has(e.id) && e.data && e.copyOf === undefined).map((e) => e.data!);
};

describe("spell slot uses (docs/design/design-v1-slots.md 3.2, 6)", () => {
  test("Use spends one slot of its level, writes a hidden line with the counts and moves the use stamp", () => {
    const s0 = table();
    const s1 = apply(s0, use({ kind: "slot", level: 3 }), P1);
    assert.deepEqual(bree(s1).spent, { slots: [0, 0, 1, 0, 0, 0, 0, 0, 0] });
    assert.equal(bree(s1).useRev, 1);
    const [line] = lines(s0, s1);
    assert.deepEqual({ ...line, characterId: undefined, tokenId: undefined, seen: undefined }, { type: "use", what: "slot", level: 3, left: 1, max: 2, hidden: true, characterId: undefined, tokenId: undefined, seen: undefined });
  });
  test("the last one spent refuses the next, and a level the character lacks says so", () => {
    let s = table();
    s = apply(s, use({ kind: "slot", level: 3 }));
    s = apply(s, use({ kind: "slot", level: 3 }));
    assert.equal(refused(s, use({ kind: "slot", level: 3 })).message, "No level 3 spell slots left.");
    assert.equal(refused(s, use({ kind: "slot", level: 4 })).message, "Bree has no level 4 spell slots.");
  });
  test("Restore gives one back, never past the count, and one with nothing spent changes nothing, the stamp included", () => {
    let s = apply(table(), use({ kind: "slot", level: 1 }));
    s = apply(s, use({ kind: "slot", level: 1 }, true));
    assert.equal(bree(s).spent, undefined);
    assert.equal(bree(s).useRev, 2);
    const again = apply(s, use({ kind: "slot", level: 1 }, true));
    assert.equal(again.characters.bree, s.characters.bree);
  });
  test("Pact Magic spends and restores apart, its line at the Pact level", () => {
    const s0 = table();
    let s = apply(s0, use({ kind: "pact" }));
    s = apply(s, use({ kind: "pact" }));
    assert.deepEqual(bree(s).spent, { pact: 2 });
    assert.equal(refused(s, use({ kind: "pact" })).message, "No Pact Magic slots left.");
    const line = lines(s0, apply(s0, use({ kind: "pact" })))[0] as Extract<LogEvent, { type: "use" }>;
    assert.deepEqual([line.what, line.level, line.left, line.max, line.hidden], ["pact", 3, 1, 2, true]);
    assert.equal(refused(table({ classes: [{ id: "wizard", level: 5 }] }), use({ kind: "pact" })).message, "Bree has no Pact Magic slots.");
  });
  test("no classes, or a creature with no character, refuses", () => {
    assert.equal(refused(table({ classes: undefined }), use({ kind: "slot", level: 1 })).message, "Add the character's classes first.");
    const s = room({ tokens: { g: token("g") } });
    assert.equal(refused(s, { t: "actor.use", target: { tokenId: "g" }, use: { kind: "slot", level: 1 } }).message, "Only a character has spell slots and Hit Point Dice.");
  });
});

describe("Hit Point Die uses", () => {
  const die = (heal?: number, back?: true) => use({ kind: "hitDie", die: 6, ...(heal !== undefined ? { heal } : {}) }, back);
  test("a typed roll spends one die and heals by it, the die's line hidden and the heal an HP line", () => {
    const s0 = table();
    const s1 = apply(s0, die(7), P1);
    assert.deepEqual(bree(s1).spent, { dice: { d6: 1 } });
    assert.equal(bree(s1).actor.hp.cur, 17);
    const all = lines(s0, s1);
    const dieLine = all.find((e) => e.type === "use");
    const hp = all.find((e) => e.type === "hp");
    assert.equal(all.length, 2);
    assert.deepEqual([dieLine!.type, (dieLine as { what: string }).what, (dieLine as { left: number }).left, (dieLine as { hidden?: true }).hidden], ["use", "hitDie", 4, true]);
    assert.equal(hp!.type, "hp");
    assert.equal(bree(s1).useRev, 1);
  });
  test("a heal stops at the most, and full HP, none left, below 1 HP and no die of the size refuse", () => {
    assert.equal(bree(apply(table(), die(100))).actor.hp.cur, 30);
    assert.equal(refused(table({ actor: actor({ hp: { cur: 30, max: 30, temp: 0 } }) }), die(3)).message, "Bree's HP is full.");
    assert.equal(refused(table({ spent: { dice: { d6: 5 } } }), die(3)).message, "No d6 Hit Point Dice left.");
    assert.equal(refused(table({ actor: actor({ hp: { cur: 0, max: 30, temp: 0 }, life: "dying" }) }), die(3)).message, "a rest needs at least 1 Hit Point");
    assert.equal(refused(table(), use({ kind: "hitDie", die: 12, heal: 3 })).message, "Bree has no d12 Hit Point Dice.");
  });
  test("Restore gives a die back and heals nothing", () => {
    const s = apply(apply(table(), die(4)), die(undefined, true));
    assert.equal(bree(s).spent, undefined);
    assert.equal(bree(s).actor.hp.cur, 14);
  });
});

describe("rests and the use stamp", () => {
  const spent = { slots: [1, 1, 1, 0, 0, 0, 0, 0, 0], pact: 2, dice: { d8: 2, d6: 1 } };
  const rest = (kind: "short" | "long"): Op => ({ t: "actor.rest", target: { characterId: "bree" }, kind });
  test("a Short Rest gives back the Pact Magic slots alone", () => {
    assert.deepEqual(bree(apply(table({ spent }), rest("short"))).spent, { slots: [1, 1, 1, 0, 0, 0, 0, 0, 0], dice: { d8: 2, d6: 1 } });
  });
  test("a Long Rest gives back every slot and die", () => {
    assert.equal(bree(apply(table({ spent }), rest("long"))).spent, undefined);
  });
  test("every rest moves the stamp from change format 68, one that gives nothing back too, and none at 67", () => {
    const s = table();
    assert.equal(bree(apply(s, rest("short"))).useRev, 1);
    assert.equal(bree(apply(apply(s, rest("short")), rest("long"), DM, 2)).useRev, 2);
    const at67 = applyOp(table({ spent }), rest("long"), DM, { ...env(1), opVersion: 67 });
    assert.ok(at67.ok);
    assert.equal(at67.state.characters.bree!.useRev, undefined);
    const use67 = applyOp(s, { t: "actor.use", target: { characterId: "bree" }, use: { kind: "resist" } }, DM, { ...env(1), opVersion: 67 });
    assert.ok(!use67.ok || use67.state.characters.bree!.useRev === undefined);
  });
  test("a class resource use moves the stamp at 68 and not at 67, a no-op give back never", () => {
    const s = table({ resources: [{ id: "r1", name: "Rage", max: 2, used: 0, reset: "long" }] });
    const op: Op = { t: "actor.use", target: { characterId: "bree" }, use: { kind: "resource", id: "r1" } };
    assert.equal(bree(apply(s, op)).useRev, 1);
    const at67 = applyOp(s, op, DM, { ...env(1), opVersion: 67 });
    assert.ok(at67.ok);
    assert.equal(at67.state.characters.bree!.useRev, undefined);
    assert.equal(apply(s, { ...op, back: true } as Op).characters.bree, s.characters.bree);
  });
});

describe("classes on a character.update", () => {
  test("a classes change clamps spent, and an empty list removes classes and spent and keeps the level", () => {
    const s = table({ level: 10, spent: { slots: [2, 2, 2, 0, 0, 0, 0, 0, 0], pact: 2 } });
    const cut = apply(s, { t: "character.update", characterId: "bree", patch: { classes: [{ id: "wizard", level: 3 }], level: 3 } });
    assert.deepEqual(bree(cut).spent, { slots: [2, 2, 0, 0, 0, 0, 0, 0, 0] });
    const none = apply(s, { t: "character.update", characterId: "bree", patch: { classes: [] } });
    assert.equal(bree(none).classes, undefined);
    assert.equal(bree(none).spent, undefined);
    assert.equal(bree(none).level, 10);
  });
});
