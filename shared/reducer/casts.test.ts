import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "../keys.ts";
import { partyIndex, rosterRanks } from "../logRings.ts";
import type { CastAsk, DiceRoll, LogEntry, RoomState } from "../model.ts";
import { ASK_CLOSED } from "../permissions.ts";
import type { CastInput, Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1, P2, castAsk, castTable, damageRoll, diceLine, env } from "../testutil.ts";
import { labelDamageType } from "./casts.ts";

/** A player's asks for saves in the room's state (docs/design-v1-player-save-spell.md 5.3). */

/** The id of an op's first line only Thorn's player reads, at seq 50 (shared/logRings.ts). */
const theirs = () => `50:${partyIndex(rosterRanks(castTable().members).get("p1")!, 0)}`;

const ask = (overrides: Partial<CastInput> = {}): Op => ({ t: "cast.ask", cast: { id: "k1", caster: "thorn", sceneId: "s1", spell: "Fireball", slot: 3, area: "a1", ...overrides } });

function run(state: RoomState, op: Op, who = P1, seq = 50) {
  const r = applyOp(state, op, who, env(seq));
  assert.ok(r.ok, r.ok ? "" : `${r.code}: ${r.message}`);
  return r;
}

/** Thorn's table with these lines in its log, oldest first. */
function withLog(...lines: LogEntry[]): RoomState {
  return castTable({ log: lines });
}

/** What the ask holds once sent with a damage roll of `parts` batches under `dmg`. */
function rolledAfter(state: RoomState, parts = 1, who = P1): CastAsk["rolled"] {
  return run(state, ask({ damage: { tag: "dmg", parts } }), who).state.casts.k1!.rolled;
}

describe("an ask for saves", () => {
  test("is stored with its asker and time from the envelope, and its line first in the op", () => {
    const r = run(castTable(), ask());
    assert.deepEqual(r.state.casts.k1, { id: "k1", rev: 1, by: "p1", caster: "thorn", sceneId: "s1", spell: "Fireball", slot: 3, area: "a1", at: env(50).at });
    // Only the caster's players read it, so it counts in Thorn's player's own run.
    assert.equal(r.log[0]!.id, theirs());
    assert.deepEqual(r.log[0]!.data, { type: "cast", castId: "k1", tokenId: "thorn", spell: "Fireball", slot: 3 });
    assert.deepEqual(r.touched, [keys.log(theirs()), keys.cast("k1")]);
  });

  test("a targets ask keeps its targets and the roll's key, and an ask with no level has none on its line", () => {
    const r = run(castTable(), ask({ area: undefined, slot: undefined, targets: ["g1", "bree"], roll: "spells:Hold Person", spell: "Hold Person" }));
    assert.deepEqual(r.state.casts.k1?.targets, ["g1", "bree"]);
    assert.equal(r.state.casts.k1?.roll, "spells:Hold Person");
    assert.deepEqual(r.log[0]!.data, { type: "cast", castId: "k1", tokenId: "thorn", spell: "Hold Person" });
  });

  test("its inverse takes the ask away, and a second ask of the same id is refused", () => {
    const r = run(castTable(), ask());
    assert.deepEqual(r.inverse, [{ key: keys.cast("k1"), value: null, expectHash: r.inverse![0]!.expectHash }]);
    const again = applyOp(r.state, ask(), P1, env(51));
    assert.ok(!again.ok);
  });
});

describe("the caster's roll, copied into the ask", () => {
  test("an ordinary single-batch roll has no part and reads as part 0", () => {
    assert.deepEqual(rolledAfter(withLog(diceLine("40:0", "dmg", [damageRoll()]))), [{ formula: "8d6", total: 28, type: "fire" }]);
  });

  test("a roll in two batches is copied whole, in part order, whatever the log's order", () => {
    const fire = damageRoll({ formula: "60d6", total: 210, label: "Meteor damage, Fire" });
    const cold = damageRoll({ formula: "60d6", total: 205, label: "Meteor damage, Cold" });
    const state = withLog(diceLine("40:0", "dmg", [cold], { part: 1 }), diceLine("41:0", "dmg", [fire], { part: 0 }));
    assert.deepEqual(rolledAfter(state, 2), [
      { formula: "60d6", total: 210, type: "fire" },
      { formula: "60d6", total: 205, type: "cold" },
    ]);
  });

  test("a rider of another type in one batch keeps both, and an untyped label keeps none", () => {
    const state = withLog(diceLine("40:0", "dmg", [damageRoll({ formula: "9d6", total: 31 }), damageRoll({ formula: "2d8", total: 9, label: "Fireball damage and Divine Smite" })]));
    assert.deepEqual(rolledAfter(state), [
      { formula: "9d6", total: 31, type: "fire" },
      { formula: "2d8", total: 9 },
    ]);
  });

  test("a roll for the caster's character counts as the caster's", () => {
    const state = withLog(diceLine("40:0", "dmg", [damageRoll({ tokenId: undefined, characterId: "thorn-c" })]));
    assert.equal(rolledAfter(state)?.length, 1);
  });

  test("a line at or past the batches named, a part twice, or a part missing leaves it absent", () => {
    const line = (id: string, part?: number) => diceLine(id, "dmg", [damageRoll()], part === undefined ? {} : { part });
    assert.equal(rolledAfter(withLog(line("40:0"), line("41:0", 1))), undefined, "a part past a one-batch roll");
    assert.equal(rolledAfter(withLog(line("40:0", 0), line("41:0", 1), line("42:0", 2)), 2), undefined, "a part past two");
    assert.equal(rolledAfter(withLog(line("40:0"), line("41:0", 0)), 1), undefined, "part 0 twice, one of them with no part");
    assert.equal(rolledAfter(withLog(line("40:0", 0)), 2), undefined, "the second batch missing");
    assert.equal(rolledAfter(withLog(line("40:0", 1)), 2), undefined, "the first batch missing");
  });

  test("is absent for another roller, another creature, a critical, a d20 test and a pruned line", () => {
    const only = (roll: DiceRoll, by = "p1") => rolledAfter(withLog(diceLine("40:0", "dmg", [roll], { by })));
    assert.equal(only(damageRoll(), "p2"), undefined, "another player's roll");
    assert.equal(only(damageRoll({ tokenId: "bree" })), undefined, "another creature");
    assert.equal(only(damageRoll({ tokenId: undefined })), undefined, "no creature");
    assert.equal(only(damageRoll({ crit: "doubleDice" })), undefined, "a critical");
    assert.equal(only(damageRoll({ formula: "1d20+5", total: 17 })), undefined, "a d20 in the formula");
    assert.equal(only(damageRoll({ save: "dex" })), undefined, "a save");
    assert.equal(only(damageRoll({ initiative: true })), undefined, "initiative");
    assert.equal(only(damageRoll({ critOn: 19 })), undefined, "an attack's range");
    assert.equal(only(damageRoll({ mode: "adv" })), undefined, "advantage");
    assert.equal(rolledAfter(castTable()), undefined, "the line pruned or never there");
  });

  test("one roll of a batch failing a check leaves the whole absent", () => {
    const state = withLog(diceLine("40:0", "dmg", [damageRoll(), damageRoll({ tokenId: "bree" })]));
    assert.equal(rolledAfter(state), undefined);
  });

  test("a Secret roll is copied like any other", () => {
    assert.equal(rolledAfter(withLog(diceLine("40:0", "dmg", [damageRoll()], { to: "dm" })))?.length, 1);
  });

  test("a damage type is the label's last clause, and only a damage type", () => {
    assert.equal(labelDamageType("Fireball damage, Fire"), "fire");
    assert.equal(labelDamageType("Rend damage, fire"), "fire");
    assert.equal(labelDamageType("Fireball damage"), undefined);
    assert.equal(labelDamageType("Fire"), undefined);
    assert.equal(labelDamageType("A very long spell name that the label cut short…"), undefined);
    assert.equal(labelDamageType("Hold Person, Paralyzed"), undefined);
    assert.equal(labelDamageType(undefined), undefined);
  });
});

describe("closing an ask", () => {
  const open = () => castTable({ casts: { k1: castAsk("k1", { rolled: [{ formula: "8d6", total: 28, type: "fire" }], damage: { tag: "dmg", parts: 1 } }) } });

  test("removes it and writes the line with its end first, for each end", () => {
    for (const [end, who] of [
      ["done", DM],
      ["dismissed", DM],
      ["withdrawn", P1],
    ] as const) {
      const r = run(open(), { t: "cast.close", castId: "k1", end }, who);
      assert.equal(r.state.casts.k1, undefined, end);
      assert.equal(r.log[0]!.id, theirs());
      assert.deepEqual(r.log[0]!.data, { type: "cast", castId: "k1", tokenId: "thorn", spell: "Fireball", slot: 3, end });
    }
  });

  test("an ask that is gone is refused in the words a page shows", () => {
    const r = applyOp(castTable(), { t: "cast.close", castId: "k1", end: "dismissed" }, DM, env(50));
    assert.ok(!r.ok);
    assert.deepEqual([r.code, r.message], ["gone", ASK_CLOSED]);
  });

  test("an outcome with the ask closes it with end done, its line before the HP lines, and its undo brings it back whole", () => {
    const before = open();
    const r = run(before, { t: "actor.outcome", plan: "pl1", label: "Fireball", cast: "k1", targets: [{ target: { tokenId: "g1" }, amount: 14 }] }, DM);
    assert.equal(r.state.casts.k1, undefined);
    assert.deepEqual(r.log[0]!.data, { type: "cast", castId: "k1", tokenId: "thorn", spell: "Fireball", slot: 3, end: "done" });
    assert.equal(r.log[1]!.data?.type, "hp");
    const restore = r.inverse!.find((e) => e.key === keys.cast("k1"));
    assert.deepEqual(restore?.value, before.casts.k1, "the ask with its rolled");
    const undone = run(r.state, { t: "sys.restore", entries: r.inverse!, from: "undo", deps: true }, DM, 51);
    assert.deepEqual({ ...undone.state.casts.k1, rev: 0 }, { ...before.casts.k1, rev: 0 }, "the card shows again, with the caster's roll");
  });

  test("the closing line's id is the same whatever the saves did, so it never counts lines the caster cannot see", () => {
    const seen = run(open(), { t: "actor.outcome", plan: "pl1", cast: "k1", targets: [{ target: { tokenId: "g1" }, amount: 14 }] }, DM);
    const hidden = run(open(), { t: "actor.outcome", plan: "pl1", cast: "k1", targets: [{ target: { tokenId: "g2" }, amount: 14 }, { target: { tokenId: "g1" }, amount: 7 }] }, DM);
    const closed = run(open(), { t: "cast.close", castId: "k1", end: "done" }, DM);
    for (const r of [seen, hidden, closed]) assert.deepEqual(r.log[0], seen.log[0]);
  });

  test("an outcome naming an ask that is gone applies nothing", () => {
    const r = applyOp(castTable(), { t: "actor.outcome", plan: "pl1", cast: "k1", targets: [{ target: { tokenId: "g1" }, amount: 14 }] }, DM, env(50));
    assert.ok(!r.ok);
    assert.deepEqual([r.code, r.message], ["gone", ASK_CLOSED]);
  });

  test("an outcome without an ask applies as before", () => {
    const r = run(open(), { t: "actor.outcome", plan: "pl1", targets: [{ target: { tokenId: "g1" }, amount: 3 }] }, DM);
    assert.ok(r.state.casts.k1);
    assert.equal(r.log[0]!.data?.type, "hp");
  });

  test("a co-owner may withdraw it as its asker may", () => {
    const state = open();
    state.characters["thorn-c"]!.ownerIds = ["p1", "p2"];
    assert.equal(run(state, { t: "cast.close", castId: "k1", end: "withdrawn" }, P2).state.casts.k1, undefined);
  });
});
