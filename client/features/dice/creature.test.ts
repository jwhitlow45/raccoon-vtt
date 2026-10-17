import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { SrdRolls } from "#shared/dice/bonus.ts";
import type { RoomState } from "#shared/model.ts";
import { loadMonsters, type SrdMonster } from "#shared/srd/monsters.ts";
import { loadSrdRolls } from "#shared/srd/rolls.ts";
import { actor, character, companionBlock, customMonster, effect, room, token } from "#shared/testutil.ts";
import { creatureRolls, type DiceView } from "./creature.ts";

/** One creature's rolls from each source, and only from a block the viewer reads (docs/design-v1-roll-options.md 3.4). */

let monsters: readonly SrdMonster[] = [];
let rolls: SrdRolls = {};
before(async () => {
  [monsters, rolls] = await Promise.all([loadMonsters(), loadSrdRolls()]);
});

const DM = { memberId: "dm1", role: "dm" } as const;
const P1 = { memberId: "p1", role: "player" } as const;

function state(): RoomState {
  return room({
    monsters: {
      lurker: customMonster("lurker", {
        resistances: "Bludgeoning, Piercing, and Slashing from Nonmagical Attacks",
        traits: [{ name: "Magic Resistance", text: "The lurker has Advantage on saving throws against spells and other magical effects." }],
      }),
    },
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"], actor: actor({ initBonus: 3, effects: [effect("e1", { key: "raging" })] }) }) },
    companionBlocks: { moth: companionBlock("moth", "bree") },
    tokens: {
      gob: token("gob", { kind: "monster", name: "Goblin", actor: { inline: actor({ srdId: "goblin-warrior", initBonus: 2 }) } }),
      lurk: token("lurk", { kind: "monster", name: "Lurker", ownerIds: ["p1"], actor: { inline: actor({ monsterId: "lurker", legendary: { actionsMax: 0, actionsUsed: 0, resistMax: 3, resistUsed: 1 } }) } }),
      moth: token("moth", { kind: "npc", name: "Moth", ownerIds: ["p1"], companion: { of: "bree", turn: "shared" }, actor: { inline: actor({ blockId: "moth" }) } }),
      bear: token("bear", { kind: "npc", name: "Bear", ownerIds: ["p1"], actor: { inline: actor({ srdId: "brown-bear", effects: [effect("e2", { key: "petrified" })] }) } }),
      breeTok: token("breeTok", { kind: "pc", name: "Bree", actor: { ref: "bree" } }),
      plain: token("plain", { kind: "monster", name: "Statue", actor: { inline: actor() } }),
    },
  });
}

function dice(you: DiceView["you"], loaded: { monsters?: boolean; rolls?: boolean } = { monsters: true, rolls: true }, view = state()): DiceView {
  return { you, view, srd: { monsters: loaded.monsters ? monsters : null, rolls: loaded.rolls ? rolls : null } };
}

describe("a creature's rolls", () => {
  test("an SRD monster waits for both chunks, then rolls with the table's numbers and its block's actions", () => {
    assert.equal(creatureRolls(dice(DM, {}), { tokenId: "gob" }), null);
    assert.equal(creatureRolls(dice(DM, { rolls: true }), { tokenId: "gob" }), null, "the block still loading");
    assert.equal(creatureRolls(dice(DM, { monsters: true }), { tokenId: "gob" }), null, "the numbers still loading");
    const gob = creatureRolls(dice(DM), { tokenId: "gob" })!;
    assert.equal(gob.numbers?.abilities.dex.save, 2);
    assert.equal(gob.initBonus, 2);
    assert.deepEqual(
      gob.named.map((r) => r.name),
      ["Scimitar", "Shortbow"],
    );
    assert.deepEqual([gob.defenses, gob.magicResistance, gob.evasion, gob.legendaryLeft], [[], false, false, 0]);
  });

  test("a room monster's block needs no chunk, with its qualified defenses, Magic Resistance and Legendary Resistance left", () => {
    const lurker = creatureRolls(dice(DM, {}), { tokenId: "lurk" })!;
    assert.equal(lurker.numbers?.abilities.wis.save, 3);
    assert.deepEqual(
      lurker.named.map((r) => [r.name, r.attack]),
      [["Bite", 4]],
    );
    assert.deepEqual(
      lurker.defenses.map((d) => [d.of, d.qualifier]),
      [
        ["bludgeoning", "from Nonmagical Attacks"],
        ["piercing", "from Nonmagical Attacks"],
        ["slashing", "from Nonmagical Attacks"],
      ],
    );
    assert.equal(lurker.magicResistance, true);
    assert.equal(lurker.legendaryLeft, 2);
  });

  test("a player reads only what the token panel shows them: a companion's block and an SRD creature they play, never a room monster's", () => {
    const moth = creatureRolls(dice(P1), { tokenId: "moth" })!;
    assert.deepEqual(
      moth.named.map((r) => [r.name, r.save]),
      [["Dust", { ability: "con", dc: 11, onPass: "none" }]],
    );
    const lurker = creatureRolls(dice(P1), { tokenId: "lurk" })!;
    assert.deepEqual([lurker.named, lurker.magicResistance, lurker.defenses], [[], false, []]);
    const bear = creatureRolls(dice(P1), { tokenId: "bear" })!;
    assert.ok(bear.named.some((r) => r.name === "Bite"));
    assert.deepEqual(creatureRolls(dice(DM), { tokenId: "moth" })!.named.length, 1, "the DM reads a companion's block too");
  });

  test("effects add their defenses to the block's: Petrified resists all", () => {
    const bear = creatureRolls(dice(DM), { tokenId: "bear" })!;
    assert.deepEqual(
      bear.defenses.map((d) => [d.kind, d.of, d.source]),
      [
        ["resist", "all", "Petrified"],
        ["immune", "poisoned", "Petrified"],
      ],
    );
  });

  test("a character, by token or by id, has its numbers and its effects' defenses until doc 2's model gives it rolls", () => {
    for (const creature of [{ tokenId: "breeTok" }, { characterId: "bree" }]) {
      const bree = creatureRolls(dice(P1, {}), creature)!;
      assert.equal(bree.numbers, null, "no stat block yet");
      assert.equal(bree.initBonus, 3);
      assert.deepEqual(bree.named, []);
      assert.deepEqual(
        bree.defenses.map((d) => d.of),
        ["bludgeoning", "piercing", "slashing"],
      );
    }
  });

  test("a character in an SRD shape waits for the table, and a hand-made token or a gone one has nothing to wait for", () => {
    const shaped = state();
    shaped.characters.bree!.actor.srdId = "brown-bear";
    assert.equal(creatureRolls(dice(P1, {}, shaped), { characterId: "bree" }), null);
    assert.equal(creatureRolls(dice(P1, { rolls: true }, shaped), { characterId: "bree" })!.numbers?.abilities.str.save, rolls["brown-bear"]!.abilities.str.save);
    const statue = creatureRolls(dice(DM, {}), { tokenId: "plain" })!;
    assert.deepEqual([statue.numbers, statue.named, statue.defenses], [null, [], []]);
    assert.equal(creatureRolls(dice(DM), { tokenId: "gone" }), null);
  });
});
