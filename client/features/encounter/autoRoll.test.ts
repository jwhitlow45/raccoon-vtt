import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import type { RandomSource } from "#shared/passphrase.ts";
import { canApply } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, P1, actor, apply, character, comparable, effect, entry, env, room, token } from "#shared/testutil.ts";
import { blankActor } from "../tokens/factory.ts";
import {
  commonModifier,
  decodePrefs,
  describeRoll,
  encodePrefs,
  joinGroups,
  noBonusSet,
  planRolls,
  rollD20,
  rollGroups,
  rollOps,
  rollRows,
  rollStillShown,
  rollWith,
  rowsToRoll,
  type RollRow,
} from "./autoRoll.ts";
import { entryName, sortedEntries } from "./logic.ts";

/** A random source that rolls the given d20 faces, in order. */
function faces(...values: number[]): RandomSource {
  let i = 0;
  return (buffer) => {
    for (let j = 0; j < buffer.length; j++) {
      const face = values[i++];
      if (face === undefined) throw new Error("the test ran out of dice");
      buffer[j] = face - 1;
    }
    return buffer;
  };
}

/** A small seeded generator (xorshift32), so the distribution checks never flake. */
function seeded(seed: number): RandomSource {
  let x = seed >>> 0 || 1;
  return (buffer) => {
    for (let j = 0; j < buffer.length; j++) {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      buffer[j] = x;
    }
    return buffer;
  };
}

const row = (entryId: string, patch: Partial<RollRow> = {}): RollRow => ({
  entryId,
  name: entryId,
  modifier: 2,
  advantage: "normal",
  value: null,
  ...patch,
});

const ids = (groups: { rows: { entryId: string }[] }[]) => groups.map((g) => g.rows.map((r) => r.entryId));

describe("the d20", () => {
  test("every face comes up about as often as the others", () => {
    const random = seeded(12345);
    const counts = new Array<number>(21).fill(0);
    const n = 40_000;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const die = rollD20(random);
      assert.ok(Number.isInteger(die) && die >= 1 && die <= 20, `a d20 rolled ${die}`);
      counts[die]!++;
      sum += die;
    }
    // 2,000 expected per face, with a standard deviation near 44: 300 is far outside chance.
    for (let face = 1; face <= 20; face++) assert.ok(Math.abs(counts[face]! - n / 20) < 300, `face ${face} came up ${counts[face]} times`);
    assert.ok(Math.abs(sum / n - 10.5) < 0.1);
  });

  test("the default source is the cryptographic one, and covers every face", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2_000; i++) {
      const die = rollD20();
      assert.ok(die >= 1 && die <= 20);
      seen.add(die);
    }
    assert.equal(seen.size, 20);
  });

  test("advantage keeps the higher of two, disadvantage the lower", () => {
    assert.deepEqual(rollWith("adv", faces(4, 17)), { dice: [4, 17], kept: 17, advantage: "adv" });
    assert.deepEqual(rollWith("dis", faces(4, 17)), { dice: [4, 17], kept: 4, advantage: "dis" });
    assert.deepEqual(rollWith("normal", faces(9)), { dice: [9], kept: 9, advantage: "normal" });
  });

  test("advantage and disadvantage shift the average as the math says", () => {
    const random = seeded(777);
    const n = 20_000;
    let adv = 0;
    let dis = 0;
    for (let i = 0; i < n; i++) {
      adv += rollWith("adv", random).kept;
      dis += rollWith("dis", random).kept;
    }
    // The exact means are 13.825 and 7.175.
    assert.ok(Math.abs(adv / n - 13.825) < 0.15, `advantage averaged ${adv / n}`);
    assert.ok(Math.abs(dis / n - 7.175) < 0.15, `disadvantage averaged ${dis / n}`);
  });
});

describe("the modifier", () => {
  test("a row rolls with its creature's initiative bonus, never its score", () => {
    const state = room();
    state.tokens = { gob: token("gob", { actor: { inline: actor({ initBonus: -1, initScore: 15 }) } }) };
    assert.equal(rollRows(state, [entry("e", { tokenId: "gob" })], () => "").rows[0]!.modifier, -1);
  });

  test("only a hand-made token's +0 reads as no bonus set", () => {
    assert.equal(noBonusSet(blankActor()), true);
    assert.equal(noBonusSet(blankActor({ initBonus: 3 })), false);
    assert.equal(noBonusSet(actor({ initBonus: 0, cr: "1/4" })), false, "a stat block's real +0");
    assert.equal(noBonusSet(undefined), false);
  });

  test("a crowd adds the modifier most of it has, the higher on a tie", () => {
    assert.equal(commonModifier([2, 2, 2, -1]), 2);
    assert.equal(commonModifier([1, 3]), 3);
    assert.equal(commonModifier([-1, -1, 4]), -1);
    assert.equal(commonModifier([0]), 0);
  });
});

describe("which rows roll", () => {
  test("monsters and NPCs the DM runs, never player characters or creatures a player owns", () => {
    const state = room();
    state.characters.c1 = character("c1");
    state.tokens = {
      gob: token("gob", { name: "Goblin", number: 1, actor: { inline: actor({ initBonus: 2 }) } }),
      npc: token("npc", { kind: "npc", name: "Guard", actor: { inline: actor({ initBonus: 1 }) } }),
      pc: token("pc", { kind: "pc", name: "Thorn", ownerIds: ["p1"], actor: { ref: "c1" } }),
      fam: token("fam", { kind: "npc", name: "Owl", ownerIds: ["p1"], actor: { inline: actor() } }),
    };
    const entries = [
      entry("e-gob", { tokenId: "gob", value: null, groupKey: "Goblin" }),
      entry("e-npc", { tokenId: "npc", value: 12, groupKey: "Guard" }),
      entry("e-pc", { tokenId: "pc", value: null }),
      entry("e-fam", { tokenId: "fam", value: null, groupKey: "Owl" }),
      entry("e-char", { characterId: "c1", value: null }),
      entry("e-lair", { label: "Lair", value: 20 }),
    ];
    const { rows, skipped } = rollRows(state, entries, (e) => entryName(state, e));
    assert.deepEqual(rows, [
      { entryId: "e-gob", name: "Goblin 1", groupKey: "Goblin", modifier: 2, advantage: "normal", value: null },
      { entryId: "e-npc", name: "Guard", groupKey: "Guard", modifier: 1, advantage: "normal", value: 12 },
    ]);
    assert.deepEqual(skipped, []);
  });

  test("the reminder comes from the DM's mark, else the creature's conditions", () => {
    const state = room();
    state.tokens = {
      inv: token("inv", { actor: { inline: actor({ effects: [effect("x", { key: "invisible" })] }) } }),
      sur: token("sur", { actor: { inline: actor({ effects: [effect("y", { key: "surprised" })] }) } }),
      stun: token("stun", { actor: { inline: actor({ effects: [effect("y", { key: "stunned" })] }) } }),
      both: token("both", { actor: { inline: actor({ effects: [effect("x", { key: "invisible" }), effect("y", { key: "surprised" })] }) } }),
      marked: token("marked", { actor: { inline: actor({ effects: [effect("x", { key: "invisible" })] }) } }),
    };
    const entries = ["inv", "sur", "stun", "both"].map((id) => entry(id, { tokenId: id }));
    entries.push(entry("marked", { tokenId: "marked", advantage: "dis" }));
    const { rows } = rollRows(state, entries, () => "");
    assert.deepEqual(
      rows.map((r) => r.advantage),
      ["adv", "dis", "dis", "normal", "dis"],
    );
  });

  test("dead monsters and every creature on another scene are reported, not rolled", () => {
    const state = room();
    state.tokens = { dead: token("dead", { actor: { inline: actor({ life: "dead" }) } }) };
    const entries = [
      entry("e-dead", { tokenId: "dead" }),
      entry("e-away", { tokenId: "elsewhere", groupKey: "goblin" }),
      entry("e-pc-away", { tokenId: "pc-elsewhere" }),
    ];
    const { rows, skipped } = rollRows(state, entries, () => "");
    assert.deepEqual(rows, []);
    assert.deepEqual(skipped, [
      { entryId: "e-dead", reason: "dead" },
      { entryId: "e-away", reason: "elsewhere" },
      { entryId: "e-pc-away", reason: "elsewhere" },
    ]);
  });

  test("the count of creatures elsewhere never depends on grouping: an ungrouped monster counts, a familiar counts as a creature", () => {
    // Two scenes: the DM views s1, and a goblin and a player's owl wait on s2.
    let state = room();
    state.tokens = {
      g1: token("g1", { name: "Goblin", number: 1, actor: { inline: actor({ srdId: "goblin-warrior" }) } }),
      away: token("away", { sceneId: "s2", name: "Goblin", number: 2, actor: { inline: actor({ srdId: "goblin-warrior" }) } }),
      owl: token("owl", { sceneId: "s2", kind: "npc", name: "Owl", ownerIds: ["p1"], actor: { inline: actor() } }),
    };
    state = apply(state, { t: "encounter.start", entries: ["g1", "away", "owl"].map((id) => ({ id: `e-${id}`, tokenId: id })) });
    const elsewhere = (s: RoomState) => {
      const dmView = projectState(s, DM, { sceneId: "s1" }) as unknown as RoomState;
      return rollRows(dmView, sortedEntries(dmView.encounter!.entries), () => "")
        .skipped.filter((k) => k.reason === "elsewhere")
        .map((k) => k.entryId)
        .sort();
    };
    assert.equal(state.encounter!.entries.find((e) => e.id === "e-owl")!.groupKey, "Owl", "a familiar gets a group key too");
    assert.deepEqual(elsewhere(state), ["e-away", "e-owl"]);
    const ungrouped = apply(state, { t: "encounter.update", entryId: "e-away", patch: { groupKey: null } });
    assert.deepEqual(elsewhere(ungrouped), ["e-away", "e-owl"]);
  });

  test("by default only rows still waiting for a value roll", () => {
    const rows = [row("a"), row("b", { value: 14 }), row("c")];
    assert.deepEqual(
      rowsToRoll(rows, false).map((r) => r.entryId),
      ["a", "c"],
    );
    assert.deepEqual(
      rowsToRoll(rows, true).map((r) => r.entryId),
      ["a", "b", "c"],
    );
  });
});

describe("grouping", () => {
  const goblins = [row("g1", { groupKey: "goblin" }), row("g2", { groupKey: "goblin" }), row("g3", { groupKey: "goblin" })];
  const ogre = row("ogre", { groupKey: "ogre", modifier: -1 });
  const wolf = row("wolf", { groupKey: "wolf" });

  test("by creature, identical monsters share one roll and every other monster rolls its own", () => {
    const groups = planRolls([goblins[0]!, ogre, goblins[1]!, wolf, goblins[2]!], "creature");
    assert.deepEqual(ids(groups), [["g1", "g2", "g3"], ["ogre"], ["wolf"]]);
    assert.deepEqual(
      groups.map((g) => g.modifier),
      [2, -1, 2],
    );
  });

  test("by creature, an ungrouped monster rolls alone", () => {
    const groups = planRolls([goblins[0]!, row("g-alone"), goblins[1]!], "creature");
    assert.deepEqual(ids(groups), [["g1", "g2"], ["g-alone"]]);
  });

  test("by creature, a member with its own reminder or modifier splits off, so each total is its own", () => {
    const groups = planRolls([goblins[0]!, { ...goblins[1]!, advantage: "adv" }, { ...goblins[2]!, modifier: 4 }], "creature");
    assert.deepEqual(ids(groups), [["g1"], ["g2"], ["g3"]]);
    assert.deepEqual(
      groups.map((g) => [g.modifier, g.advantage]),
      [
        [2, "normal"],
        [2, "adv"],
        [4, "normal"],
      ],
    );
  });

  test("one each gives every monster its own roll, groups or not", () => {
    assert.deepEqual(ids(planRolls([...goblins, ogre], "each")), [["g1"], ["g2"], ["g3"], ["ogre"]]);
  });

  test("all at once is one roll for every monster", () => {
    const [group] = planRolls([...goblins, ogre, wolf], "all");
    assert.deepEqual(ids([group!]), [["g1", "g2", "g3", "ogre", "wolf"]]);
    assert.equal(group!.modifier, 2);
    assert.equal(group!.mixedModifier, true);
    assert.equal(group!.mixedAdvantage, false);
    assert.equal(group!.advantage, "normal");
  });

  test("all at once keeps a reminder every monster shares, and rolls straight when they differ", () => {
    const [shared] = planRolls([row("a", { advantage: "dis" }), row("b", { advantage: "dis" })], "all");
    assert.equal(shared!.advantage, "dis");
    assert.equal(shared!.mixedAdvantage, false);
    assert.equal(shared!.mixedModifier, false);
    const [mixed] = planRolls([row("a", { advantage: "adv" }), row("b")], "all");
    assert.equal(mixed!.advantage, "normal");
    assert.equal(mixed!.mixedAdvantage, true);
  });

  test("no rows, no rolls", () => {
    assert.deepEqual(planRolls([], "all"), []);
    assert.deepEqual(planRolls([], "creature"), []);
  });

  test("each shared roll is rolled once and every member takes its total", () => {
    const groups = planRolls([...goblins, ogre, { ...wolf, advantage: "adv" }], "creature");
    const { result, values } = rollGroups(groups, faces(12, 7, 3, 18));
    assert.deepEqual(
      result.map((g) => [g.roll.dice, g.roll.kept, g.modifier, g.total]),
      [
        [[12], 12, 2, 14],
        [[7], 7, -1, 6],
        [[3, 18], 18, 2, 20],
      ],
    );
    assert.deepEqual(values, [
      { entryId: "g1", value: 14 },
      { entryId: "g2", value: 14 },
      { entryId: "g3", value: 14 },
      { entryId: "ogre", value: 6 },
      { entryId: "wolf", value: 20 },
    ]);
  });

  test("totals stay inside what the op accepts", () => {
    const { values } = rollGroups(planRolls([row("huge", { modifier: 40 }), row("tiny", { modifier: -60 })], "each"), faces(20, 1));
    assert.deepEqual(
      values.map((v) => v.value),
      [60, -50],
    );
  });

  test("the DM's card reads each roll plainly", () => {
    assert.equal(describeRoll({ roll: { dice: [12], kept: 12, advantage: "normal" }, modifier: 2, total: 14 }), "d20 (12) +2 = 14");
    assert.equal(
      describeRoll({ roll: { dice: [5, 17], kept: 17, advantage: "adv" }, modifier: -1, total: 16 }),
      "2d20 with advantage (5, 17) keeps 17, −1 = 16",
    );
    assert.equal(
      describeRoll({ roll: { dice: [5, 17], kept: 5, advantage: "dis" }, modifier: 0, total: 5 }),
      "2d20 with disadvantage (5, 17) keeps 5, +0 = 5",
    );
  });
});

describe("what one press sends", () => {
  test("over 100 rows go out in batches the op accepts, every row once", () => {
    const rows = Array.from({ length: 230 }, (_, i) => row(`m${i}`));
    const { ops, result } = rollOps(rows, "each", seeded(99));
    assert.deepEqual(
      ops.map((op) => (op.t === "encounter.setValues" ? op.values.length : -1)),
      [100, 100, 30],
    );
    const sent = ops.flatMap((op) => (op.t === "encounter.setValues" ? op.values.map((v) => v.entryId) : []));
    assert.deepEqual(sent, rows.map((r) => r.entryId));
    assert.equal(result.groups.length, 230);
    assert.equal(result.mode, "each");
  });

  test("a re-roll that lands on a row's own value leaves that row out, and the card still shows it", () => {
    const rows = [row("a", { value: 14 }), row("b", { value: 9 }), row("c", { value: 5 })];
    // d20 12 + 2 = 14 for a (unchanged), 3 + 2 = 5 for b, 3 + 2 = 5 for c (unchanged).
    const { ops, result } = rollOps(rows, "each", faces(12, 3, 3));
    assert.deepEqual(ops, [{ t: "encounter.setValues", values: [{ entryId: "b", value: 5 }] }]);
    assert.deepEqual(
      result.groups.map((g) => [g.rows[0]!.entryId, g.total]),
      [
        ["a", 14],
        ["b", 5],
        ["c", 5],
      ],
    );
  });

  test("nothing to send when every total is already in place", () => {
    const { ops } = rollOps([row("a", { value: 14 })], "each", faces(12));
    assert.deepEqual(ops, []);
    assert.deepEqual(rollOps([], "creature").ops, []);
  });
});

describe("a monster added mid-fight", () => {
  const goblins = [row("g1", { groupKey: "goblin", value: 14 }), row("g2", { groupKey: "goblin", value: 14 })];

  test("by creature, it takes its identical group's value instead of rolling alone", () => {
    const g3 = row("g3", { groupKey: "goblin" });
    const ogre = row("ogre", { groupKey: "ogre" });
    // One die only: the ogre's. A second roll would run out of dice.
    const { ops, result } = rollOps([g3, ogre], "creature", faces(9), goblins);
    assert.deepEqual(ops, [
      {
        t: "encounter.setValues",
        values: [
          { entryId: "ogre", value: 11 },
          { entryId: "g3", value: 14 },
        ],
      },
    ]);
    assert.deepEqual(
      result.joined.map((j) => [j.rows.map((r) => r.entryId), j.total]),
      [[["g3"], 14]],
    );
    assert.deepEqual(ids(result.groups), [["ogre"]]);
  });

  test("it rolls when it is not quite identical, ungrouped, or its group holds different values", () => {
    const invisible = row("g3", { groupKey: "goblin", advantage: "adv" });
    const tougher = row("g4", { groupKey: "goblin", modifier: 4 });
    const loner = row("g5");
    assert.deepEqual(joinGroups([invisible, tougher, loner], goblins).joined, []);
    const split = [row("g1", { groupKey: "goblin", value: 14 }), row("g2", { groupKey: "goblin", value: 6 })];
    assert.deepEqual(joinGroups([row("g3", { groupKey: "goblin" })], split).joined, []);
  });

  test("one each and all at once roll it as they always do", () => {
    const g3 = row("g3", { groupKey: "goblin" });
    assert.deepEqual(rollOps([g3], "each", faces(3), goblins).result.joined, []);
    assert.deepEqual(rollOps([g3], "all", faces(3), goblins).result.joined, []);
  });
});

describe("the card belongs to its fight", () => {
  const { result } = rollOps([row("a", { groupKey: "goblin" }), row("b", { groupKey: "goblin" }), row("c")], "creature", faces(12, 5));
  const fightWith = (...entries: [string, number | null][]) => ({ entries: entries.map(([id, value]) => ({ id, value })) });

  test("it holds while its rows keep the totals it rolled", () => {
    assert.equal(rollStillShown(result, fightWith(["a", 14], ["b", 14], ["c", 7], ["pc", 12]), false), true);
    // The DM typed over one goblin: the others still carry the roll.
    assert.equal(rollStillShown(result, fightWith(["a", 3], ["b", 14], ["c", 3]), false), true);
  });

  test("it goes when the fight ends or another one starts", () => {
    assert.equal(rollStillShown(result, null, false), false);
    // A new fight has new rows, even when a total happens to match.
    assert.equal(rollStillShown(result, fightWith(["x", 14], ["y", 7]), false), false);
  });

  test("it goes when an undo takes the roll back, but not while the roll is still on its way", () => {
    assert.equal(rollStillShown(result, fightWith(["a", null], ["b", null], ["c", null]), false), false);
    assert.equal(rollStillShown(result, fightWith(["a", null], ["b", null], ["c", null]), true), true);
    assert.equal(rollStillShown(result, fightWith(["x", null]), true), false, "waiting never keeps it into another fight");
  });
});

describe("the remembered mode", () => {
  test("round trips, and anything else reads as by creature", () => {
    assert.deepEqual(decodePrefs(encodePrefs({ mode: "all" })), { mode: "all" });
    assert.deepEqual(decodePrefs(encodePrefs({ mode: "each" })), { mode: "each" });
    assert.deepEqual(decodePrefs(null), { mode: "creature" });
    assert.deepEqual(decodePrefs("{"), { mode: "creature" });
    assert.deepEqual(decodePrefs('{"mode":"boss"}'), { mode: "creature" });
    assert.deepEqual(decodePrefs("null"), { mode: "creature" });
  });
});

// ---------------------------------------------------------------- against the real reducer

/** A fight: Thorn (a PC), three goblins, an ogre and a hidden assassin, nobody rolled yet. */
function fight(): RoomState {
  let state = room();
  state.characters.c1 = character("c1", { name: "Thorn", actor: actor({ initBonus: 2 }) });
  state.tokens = {
    thorn: token("thorn", { kind: "pc", name: "Thorn", ownerIds: ["p1"], actor: { ref: "c1" }, x: 1, y: 1 }),
    g1: token("g1", { name: "Goblin", number: 1, actor: { inline: actor({ initBonus: 2, srdId: "goblin-warrior" }) }, x: 2, y: 2 }),
    g2: token("g2", { name: "Goblin", number: 2, actor: { inline: actor({ initBonus: 2, srdId: "goblin-warrior" }) }, x: 3, y: 2 }),
    g3: token("g3", { name: "Goblin", number: 3, actor: { inline: actor({ initBonus: 2, srdId: "goblin-warrior" }) }, x: 4, y: 2 }),
    ogre: token("ogre", { name: "Ogre", actor: { inline: actor({ initBonus: -1 }) }, x: 6, y: 6 }),
    sly: token("sly", { name: "Assassin", visibility: "dm", actor: { inline: actor({ initBonus: 4 }) }, x: 8, y: 8 }),
  };
  state = apply(state, {
    t: "encounter.start",
    entries: ["thorn", "g1", "g2", "g3", "ogre", "sly"].map((id) => ({ id: `e-${id}`, tokenId: id })),
  });
  return state;
}

function rolled(state: RoomState, mode: "creature" | "each" | "all", random: RandomSource) {
  const entries = sortedEntries(state.encounter!.entries);
  const { rows } = rollRows(state, entries, (e) => entryName(state, e));
  return rollGroups(planRolls(rowsToRoll(rows, false), mode), random);
}

describe("auto initiative against the reducer", () => {
  test("the rolled values apply as one setValues, sorted, with the PC untouched", () => {
    const before = fight();
    const { values } = rolled(before, "creature", faces(11, 9, 15));
    // Rows without values sort by the tie rule (PCs first, then higher bonus), so the assassin's roll comes first.
    assert.deepEqual(
      values.map((v) => [v.entryId, v.value]),
      [
        ["e-sly", 15],
        ["e-g1", 11],
        ["e-g2", 11],
        ["e-g3", 11],
        ["e-ogre", 14],
      ],
    );
    const after = apply(before, { t: "encounter.setValues", values });
    const order = sortedEntries(after.encounter!.entries).map((e) => [e.id, e.value]);
    assert.deepEqual(order, [
      ["e-sly", 15],
      ["e-ogre", 14],
      ["e-g1", 11],
      ["e-g2", 11],
      ["e-g3", 11],
      ["e-thorn", null],
    ]);
    // Nothing else about the room changed, and no log line was written.
    assert.equal(after.log.length, before.log.length);
    assert.deepEqual(comparable({ ...after, encounter: null }), comparable({ ...before, encounter: null }));
  });

  test("a tie with a player character follows the existing rule: the PC goes first", () => {
    let state = fight();
    state = apply(state, { t: "encounter.setValue", entryId: "e-thorn", value: 13 }, P1);
    const { values } = rolled(state, "all", faces(11));
    state = apply(state, { t: "encounter.setValues", values });
    assert.deepEqual(
      sortedEntries(state.encounter!.entries).map((e) => e.id),
      ["e-thorn", "e-sly", "e-g1", "e-g2", "e-g3", "e-ogre"],
    );
  });

  test("one undo takes the whole roll back", () => {
    const before = fight();
    const { values } = rolled(before, "each", faces(3, 4, 5, 6, 7));
    const r = applyOp(before, { t: "encounter.setValues", values }, DM, env(2));
    assert.ok(r.ok && r.inverse);
    const back = applyOp(r.state, { t: "sys.restore", entries: r.inverse, from: "undo" }, DM, env(3));
    assert.ok(back.ok);
    assert.deepEqual(
      back.state.encounter!.entries.map((e) => [e.id, e.value]),
      before.encounter!.entries.map((e) => [e.id, e.value]),
    );
  });

  test("the card follows the fight through an undo, the end, and the next fight", () => {
    const before = fight();
    const entries = sortedEntries(before.encounter!.entries);
    const { ops, result } = rollOps(rollRows(before, entries, (e) => entryName(before, e)).rows, "creature", faces(11, 9, 15));
    const r = applyOp(before, ops[0]!, DM, env(2));
    assert.ok(r.ok && r.inverse);
    assert.equal(rollStillShown(result, r.state.encounter, false), true);
    const undone = applyOp(r.state, { t: "sys.restore", entries: r.inverse, from: "undo" }, DM, env(3));
    assert.ok(undone.ok);
    assert.equal(rollStillShown(result, undone.state.encounter, false), false, "undo took the roll back");
    const ended = apply(r.state, { t: "encounter.end" });
    assert.equal(rollStillShown(result, ended.encounter, false), false, "the fight ended");
    const next = apply(ended, { t: "encounter.start", entries: ["g1", "g2", "ogre"].map((id) => ({ id: `next-${id}`, tokenId: id, value: 11 })) });
    assert.equal(rollStillShown(result, next.encounter, false), false, "a new fight with the same monsters and totals");
  });

  test("a goblin added mid-fight joins its group's value, and the DM can still ungroup it", () => {
    let state = fight();
    const { values } = rolled(state, "creature", faces(11, 9, 15));
    state = apply(state, { t: "encounter.setValues", values });
    state.tokens.g4 = token("g4", { name: "Goblin", number: 4, actor: { inline: actor({ initBonus: 2, srdId: "goblin-warrior" }) }, x: 5, y: 2 });
    state = apply(state, { t: "encounter.add", entries: [{ id: "e-g4", tokenId: "g4" }] });
    const { rows } = rollRows(state, sortedEntries(state.encounter!.entries), (e) => entryName(state, e));
    const kept = rows.filter((r) => r.value !== null);
    // No dice at all: the new goblin rolls nothing.
    const { ops } = rollOps(rowsToRoll(rows, false), "creature", faces(), kept);
    state = apply(state, ops[0]!);
    assert.deepEqual(
      sortedEntries(state.encounter!.entries).map((e) => [e.id, e.value]),
      [
        ["e-sly", 15],
        ["e-ogre", 14],
        ["e-g1", 11],
        ["e-g2", 11],
        ["e-g3", 11],
        ["e-g4", 11],
        ["e-thorn", null],
      ],
    );
    // Ungrouped, it would have rolled on its own.
    const alone = rollRows(state, sortedEntries(state.encounter!.entries), () => "").rows.map((r) => (r.entryId === "e-g4" ? { ...r, groupKey: undefined, value: null } : r));
    const { result } = rollOps(rowsToRoll(alone, false), "creature", faces(4), kept);
    assert.deepEqual(result.joined, []);
    assert.deepEqual(ids(result.groups), [["e-g4"]]);
  });

  test("players cannot send it: setValues is the DM's", () => {
    const state = fight();
    const { values } = rolled(state, "creature", faces(11, 9, 15));
    const decision = canApply({ t: "encounter.setValues", values }, P1, state, { canUseAsset: () => true });
    assert.equal(decision.ok, false);
  });

  test("players receive exactly what typed values would give them: the order, never the hidden row", () => {
    const before = fight();
    const { values } = rolled(before, "creature", faces(11, 9, 15));
    const rolledState = apply(before, { t: "encounter.setValues", values });
    // The same totals typed by hand, one value at a time.
    let typed = before;
    for (const v of values) typed = apply(typed, { t: "encounter.setValue", entryId: v.entryId, value: v.value });
    const opts = { sceneId: "s1" };
    const forPlayer = projectState(rolledState, P1, opts);
    // Five typed ops bump the encounter's rev five times, one setValues once: everything else must match.
    assert.deepEqual({ ...forPlayer.encounter!, rev: 0 }, { ...projectState(typed, P1, opts).encounter!, rev: 0 });
    assert.deepEqual(forPlayer.log, projectState(typed, P1, opts).log);
    const shown = forPlayer.encounter!.entries;
    assert.ok(!shown.some((e) => e.id === "e-sly"), "the hidden assassin's row stays hidden");
    for (const e of shown) assert.deepEqual(Object.keys(e).sort(), ["hidden", "id", "inLair", "reactionUsed", "tieOrder", "tokenId", "value"]);
  });

  test("ungrouping is a DM-only row edit that players never see, and then each goblin rolls its own", () => {
    const before = fight();
    let state = before;
    for (const id of ["e-g1", "e-g2", "e-g3"]) state = apply(state, { t: "encounter.update", entryId: id, patch: { groupKey: null } });
    const opts = { sceneId: "s1" };
    assert.deepEqual(projectState(state, P1, opts).encounter!.entries, projectState(before, P1, opts).encounter!.entries);
    assert.equal(canApply({ t: "encounter.update", entryId: "e-g1", patch: { groupKey: null } }, P1, before, { canUseAsset: () => true }).ok, false);
    const { rows } = rollRows(state, sortedEntries(state.encounter!.entries), (e) => entryName(state, e));
    assert.deepEqual(ids(planRolls(rows, "creature")), [["e-sly"], ["e-g1"], ["e-g2"], ["e-g3"], ["e-ogre"]]);
    const grouped = rollRows(before, sortedEntries(before.encounter!.entries), (e) => entryName(before, e)).rows;
    assert.deepEqual(ids(planRolls(grouped, "creature")), [["e-sly"], ["e-g1", "e-g2", "e-g3"], ["e-ogre"]]);
  });
});
