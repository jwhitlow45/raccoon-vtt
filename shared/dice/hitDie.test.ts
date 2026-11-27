import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { SrdRolls } from "./bonus.ts";
import { loadSrdRolls } from "../srd/rolls.ts";
import type { Character, DiceRoll, LogEvent, RoomState } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { EMPTY_PC_STATS } from "../rules/pcStats.ts";
import { actor, character, DM, env, P1, room, token } from "../testutil.ts";
import { CON_FROM_NUMBERS, resolveDiceOp } from "./resolve.ts";

/** A Short Rest's Hit Point Die on the server (docs/design/design-v1-slots.md 3.3, 6). */
let srd: SrdRolls = {};
before(async () => {
  srd = await loadSrdRolls();
});

const stats = (con: number) => ({ ...EMPTY_PC_STATS, abilities: { ...EMPTY_PC_STATS.abilities, con } });
function table(overrides: Partial<Character> = {}): RoomState {
  return room({
    characters: { thorn: character("thorn", { name: "Thorn", classes: [{ id: "druid", level: 5 }], actor: actor({ hp: { cur: 10, max: 30, temp: 0 } }), ...overrides }) },
    tokens: { t1: token("t1", { kind: "pc", actor: { ref: "thorn" }, ownerIds: ["p1"] }) },
  });
}
const roll = (extra: Partial<Extract<Op, { t: "actor.hitDieRoll" }>> = {}) => ({ t: "actor.hitDieRoll" as const, tag: "t1", target: { characterId: "thorn" }, die: 8 as const, ...extra });
const resolve = (state: RoomState, op = roll(), face = 5) => resolveDiceOp(op, state, { draw: () => face, batch: "AbCdEfGhIjKlMnOp", srd });

describe("the Hit Point Die roll", () => {
  test("adds the block's Constitution modifier", () => {
    const r = resolve(table({ stats: stats(14) }));
    assert.ok(r.ok);
    assert.equal(r.op.results[0]!.total, 7);
  });
  test("in Wild Shape as a Brown Bear over a base +0 adds the beast's +2", () => {
    const r = resolve(table({ stats: stats(10), actor: actor({ hp: { cur: 10, max: 30, temp: 0 }, srdId: "brown-bear", wildShape: true }) }));
    assert.ok(r.ok);
    assert.equal(r.op.results[0]!.total, 7);
  });
  test("another shape with no block reads the creature's own", () => {
    const r = resolve(table({ actor: actor({ hp: { cur: 10, max: 30, temp: 0 }, srdId: "brown-bear" }) }));
    assert.ok(r.ok);
    assert.equal(r.op.results[0]!.total, 7);
  });
  test("with no block and no shape it takes the typed modifier, and refuses one where the numbers give it", () => {
    const bare = resolve(table(), roll({ con: -1 }));
    assert.ok(bare.ok);
    assert.equal(bare.op.results[0]!.total, 4);
    const typed = resolve(table({ stats: stats(14) }), roll({ con: 3 }));
    assert.deepEqual(typed.ok ? null : typed.message, CON_FROM_NUMBERS);
  });
  test("refuses before the draw at full HP, with none left, below 1 HP and with no classes", () => {
    let drawn = 0;
    const draw = () => (drawn++, 4);
    const cases: [Partial<Character>, string][] = [
      [{ actor: actor({ hp: { cur: 30, max: 30, temp: 0 } }) }, "Thorn's HP is full."],
      [{ spent: { dice: { d8: 5 } } }, "No d8 Hit Point Dice left."],
      [{ actor: actor({ hp: { cur: 0, max: 30, temp: 0 }, life: "dying" }) }, "a rest needs at least 1 Hit Point"],
      [{ classes: undefined }, "Add the character's classes first."],
    ];
    for (const [overrides, message] of cases) {
      const r = resolveDiceOp(roll(), table(overrides), { draw, batch: "AbCdEfGhIjKlMnOp", srd });
      assert.equal(r.ok ? null : r.message, message);
    }
    assert.equal(drawn, 0);
  });
  test("spends a die and heals by the total, at least 1, with a hitDie roll on the character and its HP line", () => {
    const s0 = table({ stats: stats(1) });
    const r = resolve(s0, roll(), 1);
    assert.ok(r.ok);
    assert.equal(r.op.results[0]!.total, -4);
    const done = applyOp(s0, r.op, P1, env(1));
    assert.ok(done.ok);
    const after = done.state.characters.thorn!;
    assert.equal(after.actor.hp.cur, 11);
    assert.deepEqual(after.spent, { dice: { d8: 1 } });
    assert.equal(after.useRev, 1);
    const events = done.state.log.filter((e) => e.copyOf === undefined && e.data).map((e) => e.data!) as LogEvent[];
    const dice = events.find((e) => e.type === "dice") as Extract<LogEvent, { type: "dice" }>;
    const rolled: DiceRoll = dice.rolls[0]!;
    assert.deepEqual([rolled.hitDie, rolled.characterId, rolled.tokenId, rolled.label], [8, "thorn", undefined, "Hit Point Die (d8)"]);
    assert.ok(events.some((e) => e.type === "hp"));
    assert.ok(events.some((e) => e.type === "use" && e.what === "hitDie" && e.hidden === true));
  });
  test("a token's roll still names the character, never the token", () => {
    const r = resolve(table(), { ...roll(), target: { tokenId: "t1" } });
    assert.ok(r.ok);
    const done = applyOp(table(), r.op, DM, env(1));
    assert.ok(done.ok);
    const dice = done.state.log.map((e) => e.data).find((e) => e?.type === "dice") as Extract<LogEvent, { type: "dice" }>;
    assert.deepEqual([dice.rolls[0]!.characterId, dice.rolls[0]!.tokenId], ["thorn", undefined]);
  });
});
