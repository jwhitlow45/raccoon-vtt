import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { NamedRoll } from "#shared/dice/bonus.ts";
import type { PcStats, RoomState } from "#shared/model.ts";
import { actor, character, customMonster, room, token } from "#shared/testutil.ts";
import type { DiceView } from "../creature.ts";
import { actionFill, areaFill } from "./fills.ts";

/** Where a group save's fields start (docs/design-v1-roll-options.md 5.6, Appendix C). */

const MAGE: PcStats = {
  abilities: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
  saves: ["int", "wis"],
  skills: {},
  spellAbility: "int",
  adjust: {},
  defenses: {},
  rolls: [{ id: "fb", name: "Fireball", kind: "spell", ability: "spell", level: 3, save: { ability: "dex", onPass: "half" }, dice: [{ formula: "8d6", type: "fire", upcast: "1d6" }] }],
};

function state(): RoomState {
  return room({
    monsters: { mage: customMonster("mage", { traits: [{ name: "Spellcasting", text: "The mage casts spells (spell save DC 14, +6 to hit with spell attacks)." }] }) },
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"], level: 11, stats: MAGE }) },
    tokens: {
      cultist: token("cultist", { kind: "monster", name: "Cultist", actor: { inline: actor({ monsterId: "mage" }) } }),
      breeTok: token("breeTok", { kind: "pc", name: "Bree", ownerIds: ["p1"], actor: { ref: "bree" } }),
    },
  });
}
const dice = (): DiceView => ({ you: { memberId: "dm1", role: "dm" }, view: state(), srd: { monsters: [], rolls: {} } });

describe("an area's fill", () => {
  test("Fireball from a monster: the preset's save and damage, the caster's Spellcasting DC, and more dice for a higher slot", () => {
    const fill = areaFill(dice(), { spell: "Fireball", casterId: "cultist" })!;
    assert.deepEqual([fill.test, fill.dc, fill.spell, fill.outcome.damage, fill.outcome.onPass, fill.outcome.slot], [{ kind: "save", ability: "dex" }, 14, true, "8d6 fire", "half", 3]);
    assert.equal(fill.fill.from, "From Fireball: Dexterity save, DC 14 (Cultist's spell save DC), 8d6 fire, half on a pass.");
    assert.equal(areaFill(dice(), { spell: "Fireball", casterId: "cultist" }, 5)!.outcome.damage, "10d6 fire");
  });

  test("a character's own spell gives its DC and dice, and a cantrip grows with its level", () => {
    const own = areaFill(dice(), { spell: "Fireball", casterId: "breeTok" })!;
    assert.equal(own.dc, 16, "8 + proficiency 4 + Intelligence 4");
    assert.equal(own.outcome.damage, "8d6 fire");
    assert.equal(areaFill(dice(), { spell: "Acid Splash", casterId: "breeTok" })!.outcome.damage, "3d6 acid", "level 11: three dice");
    assert.equal(areaFill(dice(), { spell: "Flame Strike" })!.outcome.damage, "5d6 fire + 5d6 radiant");
  });

  test("a preset everyone takes opens as No save, and an area with no preset fills nothing", () => {
    assert.deepEqual(areaFill(dice(), { spell: "Spike Growth" })!.test, { kind: "none" });
    assert.equal(areaFill(dice(), { spell: "A homebrew blast" }), null);
  });
});

describe("a save action's fill", () => {
  test("its ability, DC, parts that are not optional, half or none, conditions and their end on the acting creature", () => {
    const breath: NamedRoll = {
      key: "actions:thunderclap",
      name: "Thunderclap",
      section: "legendaryActions",
      save: { ability: "con", dc: 17, onPass: "none" },
      damage: [
        { formula: "3d6", type: "thunder" },
        { formula: "1d6", type: "fire", optional: true },
      ],
      conditions: ["deafened"],
      lasts: { at: "end", of: "target" },
    };
    const fill = actionFill(dice(), breath, { key: "t:cultist", tokenId: "cultist" })!;
    assert.deepEqual([fill.test, fill.dc, fill.outcome.damage, fill.outcome.conditions, fill.outcome.lasts?.mode, fill.outcome.lasts?.anchor], [{ kind: "save", ability: "con" }, 17, "3d6 thunder", ["deafened"], "turnEnd", "own"]);
    assert.equal(fill.fill.from, "From Thunderclap: Constitution save, DC 17, 3d6 thunder, none on a pass, Deafened on a fail.");
  });
});
