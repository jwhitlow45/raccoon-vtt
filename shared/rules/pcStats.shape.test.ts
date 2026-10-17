import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Character, PcStats } from "../model.ts";
import { blockRollNumbers, creatureBonus, creatureNumbers, pcRollNumbers, type RollNumbers, type RollSources } from "../dice/bonus.ts";
import { actor, character, customMonster, token } from "../testutil.ts";
import { EMPTY_PC_STATS, pcDefenses, pcNamedRolls, shapedInitiative, shapedNumbers, withShapeRules } from "./pcStats.ts";

/** Wild Shape and other shapes on a character's own token (docs/design-v1-pc-stats.md 3.6, Appendix C). */

/** Bree, a level 5 druid: Str 10, Dex 14, Con 14, Wis 16, proficient in Int and Wis saves and Perception. */
const BREE: PcStats = {
  ...structuredClone(EMPTY_PC_STATS as PcStats),
  abilities: { str: 10, dex: 14, con: 14, int: 10, wis: 16, cha: 10 },
  saves: ["int", "wis"],
  skills: { perception: "prof" },
  spellAbility: "wis",
  evasion: true,
  defenses: { fire: "resistant" },
  rolls: [
    { id: "staff", name: "Quarterstaff", kind: "weapon", ability: "str", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d6", type: "bludgeoning", mod: true }] },
    { id: "moon", name: "Moonbeam", kind: "spell", ability: "spell", level: 2, save: { ability: "con", onPass: "half" }, dice: [{ formula: "2d10", type: "radiant", upcast: "1d10" }] },
    { id: "die", name: "Hit Point Die", kind: "other", dice: [{ formula: "1d8", mod: true }] },
  ],
};

/** The SRD Brown Bear: Str 17, Dex 12, Con 15, Wis 13, every save its modifier, Perception +3. */
const BEAR: RollNumbers = blockRollNumbers(
  customMonster("bear", {
    abilities: { str: { score: 17, save: 3 }, dex: { score: 12, save: 1 }, con: { score: 15, save: 2 }, int: { score: 2, save: -4 }, wis: { score: 13, save: 1 }, cha: { score: 7, save: -2 } },
    skills: "Perception +3",
    traits: [],
    actions: [],
  }),
);

function bree(shape: { srdId?: string; wildShape?: true } = {}, stats: PcStats | null = BREE): Character {
  return character("bree", { name: "Bree", level: 5, ...(stats ? { stats } : {}), actor: actor({ initBonus: 2, ...shape }) });
}

describe("Wild Shape with a stat block (Appendix C)", () => {
  test("Str from the bear, the higher of each save and skill, the druid's spell DC", () => {
    const n = shapedNumbers(bree({ srdId: "brown-bear", wildShape: true }), BEAR)!;
    assert.equal(n.abilities.str.save, 3, "the bear's +3 with no proficiency, +3 either way");
    assert.equal(n.abilities.wis.save, 6, "3 + 3 against the bear's +1");
    assert.equal(n.abilities.int.save, 0 + 3, "the druid's Int and proficiency");
    assert.equal(n.skills.perception, 6, "3 + 3 against +3");
    assert.equal(n.skills.athletics, 3, "the bear's Strength");
    assert.equal(n.abilities.dex.mod, 1);
    assert.equal(n.abilities.wis.mod, 3);
    assert.equal(n.spellDc, 14);
    assert.equal(shapedInitiative(bree({ srdId: "brown-bear", wildShape: true }), BEAR), 1, "the bear's Dex");
  });

  test("Alert, the checks bonus and the initiative adjustment stay on a shaped initiative, and none without a block", () => {
    const alert = bree({ srdId: "brown-bear", wildShape: true }, { ...BREE, alert: true, adjust: { allChecks: 1, init: 1 } });
    assert.equal(shapedInitiative(alert, BEAR), 1 + 3 + 1 + 1);
    assert.equal(shapedNumbers(bree({}, null), BEAR), null);
    assert.equal(shapedInitiative(bree({}, null), BEAR), null);
  });
});

describe("which numbers roll (doc 1's dispatch)", () => {
  const sources = (c: Character, srd: RollSources["srd"] = { "brown-bear": BEAR }): RollSources => ({
    tokens: { t: token("t", { kind: "pc", actor: { ref: "bree" } }) },
    characters: { bree: c },
    companionBlocks: {},
    srd,
  });

  test("Wild Shape with a block mixes, without a block or in another shape the bear's own, and no shape the block's", () => {
    assert.equal(creatureBonus(sources(bree({ srdId: "brown-bear", wildShape: true })), { tokenId: "t" }, { kind: "save", ability: "wis" }), 6);
    assert.equal(creatureBonus(sources(bree({ srdId: "brown-bear", wildShape: true }, null)), { tokenId: "t" }, { kind: "save", ability: "wis" }), 1);
    assert.equal(creatureBonus(sources(bree({ srdId: "brown-bear" })), { characterId: "bree" }, { kind: "save", ability: "wis" }), 1, "Polymorph");
    assert.deepEqual(creatureNumbers(sources(bree()), { characterId: "bree" }), pcRollNumbers(bree()));
  });

  test("a shape whose creature the table lacks, or no table yet, gives no bonus", () => {
    assert.equal(creatureNumbers(sources(bree({ srdId: "brown-bear", wildShape: true }), null), { tokenId: "t" }), null);
    assert.equal(creatureBonus(sources(bree({ srdId: "owlbear", wildShape: true })), { tokenId: "t" }, { kind: "initiative" }), null);
  });

  test("initiative: the beast's Dexterity in Wild Shape with a block, else the actor's, Polymorph included", () => {
    assert.equal(creatureBonus(sources(bree({ srdId: "brown-bear", wildShape: true })), { tokenId: "t" }, { kind: "initiative" }), 1);
    assert.equal(creatureBonus(sources(bree({ srdId: "brown-bear", wildShape: true })), { characterId: "bree" }, { kind: "initiative" }), 1);
    assert.equal(creatureBonus(sources(bree({ srdId: "brown-bear" })), { tokenId: "t" }, { kind: "initiative" }), 2, "Polymorph keeps the actor's");
    assert.equal(creatureBonus(sources(bree({ srdId: "brown-bear", wildShape: true }, null)), { tokenId: "t" }, { kind: "initiative" }), 2, "Wild Shape without a block");
    assert.equal(creatureBonus(sources(bree()), { tokenId: "t" }, { kind: "initiative" }), 2);
  });

  test("a room monster linked on a character is no shape: the character's own numbers", () => {
    assert.deepEqual(creatureNumbers(sources(character("bree", { level: 5, stats: BREE, actor: actor({ monsterId: "m1" }) })), { characterId: "bree" }), pcRollNumbers(bree()));
  });
});

describe("rolls and defenses in a shape", () => {
  test("Wild Shape keeps only the other rolls, another shape none", () => {
    assert.deepEqual(pcNamedRolls(bree()).map((r) => r.key), ["staff", "moon", "die"]);
    assert.deepEqual(pcNamedRolls(bree({ srdId: "brown-bear", wildShape: true })).map((r) => r.key), ["die"]);
    assert.deepEqual(pcNamedRolls(bree({ srdId: "brown-bear" })), []);
  });

  test("no damage defenses in a shape, Evasion kept in Wild Shape and gone in Polymorph", () => {
    assert.deepEqual(pcDefenses(bree()), { defenses: [{ kind: "resist", of: "fire", source: "Stat block" }], evasion: true });
    assert.deepEqual(pcDefenses(bree({ srdId: "brown-bear", wildShape: true })), { defenses: [], evasion: true });
    assert.deepEqual(pcDefenses(bree({ srdId: "brown-bear" })), { defenses: [], evasion: false });
  });
});

describe("a file's Wild Shape marks", () => {
  test("kept beside a character's creature, dropped alone or on a token's own actor", () => {
    const state = {
      characters: { kept: bree({ srdId: "brown-bear", wildShape: true }), alone: character("alone", { actor: actor({ wildShape: true }) }) },
      tokens: { t: token("t", { actor: { inline: actor({ srdId: "wolf", wildShape: true }) } }) },
    };
    const out = withShapeRules(state);
    assert.equal(out.characters.kept, state.characters.kept);
    assert.equal(out.characters.alone?.actor.wildShape, undefined);
    assert.equal("inline" in out.tokens.t!.actor && out.tokens.t!.actor.inline.wildShape, undefined);
    const clean = { characters: { kept: state.characters.kept }, tokens: {} };
    assert.equal(withShapeRules(clean), clean);
  });
});
