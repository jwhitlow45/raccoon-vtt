import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { NamedRoll } from "#shared/dice/bonus.ts";
import type { PcStats, RoomState } from "#shared/model.ts";
import { actor, character, customMonster, room, token } from "#shared/testutil.ts";
import type { DiceView } from "../creature.ts";
import { pcNamedRolls } from "#shared/rules/pcStats.ts";
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

/** A caster whose spells say nothing of a pass, as a D&D Beyond import or a new spell in the editor leaves them: unknown, never "none". */
const UNSAID: PcStats = {
  ...MAGE,
  rolls: [
    { id: "fb2", name: "Fireball", kind: "spell", ability: "spell", level: 3, save: { ability: "dex" }, dice: [{ formula: "8d6", type: "fire", upcast: "1d6" }] },
    { id: "ray", name: "Hold Ray", kind: "spell", ability: "spell", level: 2, save: { ability: "wis" }, dice: [{ formula: "4d6", type: "psychic" }] },
    { id: "sf", name: "Sacred Flame", kind: "spell", ability: "spell", level: 0, save: { ability: "dex" }, dice: [{ formula: "1d8", type: "radiant" }] },
  ],
};

function state(): RoomState {
  return room({
    monsters: { mage: customMonster("mage", { traits: [{ name: "Spellcasting", text: "The mage casts spells (spell save DC 14, +6 to hit with spell attacks)." }] }) },
    characters: {
      bree: character("bree", { name: "Bree", ownerIds: ["p1"], level: 11, stats: MAGE }),
      wren: character("wren", { name: "Wren", ownerIds: ["p2"], level: 5, stats: UNSAID }),
    },
    tokens: {
      cultist: token("cultist", { kind: "monster", name: "Cultist", actor: { inline: actor({ monsterId: "mage" }) } }),
      breeTok: token("breeTok", { kind: "pc", name: "Bree", ownerIds: ["p1"], actor: { ref: "bree" } }),
      wrenTok: token("wrenTok", { kind: "pc", name: "Wren", ownerIds: ["p2"], actor: { ref: "wren" } }),
    },
  });
}
const dice = (): DiceView => ({ you: { memberId: "dm1", role: "dm" }, view: state(), srd: { monsters: [], rolls: {} } });

describe("an area's fill", () => {
  test("Fireball from a monster: the preset's save and damage, the caster's Spellcasting DC, and more dice for a higher slot", () => {
    const fill = areaFill(dice(), { spell: "Fireball", casterId: "cultist" })!;
    assert.deepEqual([fill.test, fill.dc, fill.spell, fill.outcome.damage, fill.outcome.onPass, fill.outcome.slot], [{ kind: "save", ability: "dex" }, 14, true, "8d6 Fire", "half", 3]);
    assert.equal(fill.fill.from, "From Fireball: Dexterity save, DC 14 (Cultist's spell save DC), 8d6 Fire, half on a pass.");
    assert.equal(areaFill(dice(), { spell: "Fireball", casterId: "cultist" }, 5)!.outcome.damage, "10d6 Fire");
    // A slot below the spell's own reads as its own, which the page's stepper then shows (LP7-PC-8).
    const low = areaFill(dice(), { spell: "Fireball", casterId: "cultist" }, 1)!;
    assert.deepEqual([low.outcome.slot, low.outcome.damage], [3, "8d6 Fire"]);
  });

  test("a character's own spell gives its DC and dice, and a cantrip grows with its level", () => {
    const own = areaFill(dice(), { spell: "Fireball", casterId: "breeTok" })!;
    assert.equal(own.dc, 16, "8 + proficiency 4 + Intelligence 4");
    assert.equal(own.outcome.damage, "8d6 Fire");
    assert.equal(areaFill(dice(), { spell: "Acid Splash", casterId: "breeTok" })!.outcome.damage, "3d6 Acid", "level 11: three dice");
    assert.equal(areaFill(dice(), { spell: "Flame Strike" })!.outcome.damage, "5d6 Fire + 5d6 Radiant");
  });

  test("a PC caster's own spell takes half or none as its stat block resolves it, one rule kept in pcNamedRolls, and a caster without it the preset's (W7B-P-2)", () => {
    const d = dice();
    const fill = areaFill(d, { spell: "Fireball", casterId: "wrenTok" })!;
    const resolved = pcNamedRolls(d.view.characters.wren!).find((r) => r.key === "fb2")!.save!.onPass;
    assert.equal(fill.outcome.onPass, resolved, "the stat block's resolution, never one of the fill's own");
    assert.equal(resolved, "half", "an unset Fireball takes the SRD's half");
    assert.match(fill.fill.from, new RegExp(`${resolved} on a pass`));
    assert.equal(fill.outcome.damage, "8d6 Fire", "its own dice still");
    assert.equal(areaFill(d, { spell: "Fireball", casterId: "breeTok" })!.outcome.onPass, "half", "typed half");
    assert.equal(areaFill(d, { spell: "Fireball", casterId: "cultist" })!.outcome.onPass, "half", "a monster caster takes the preset's");
  });

  test("a save that ends the conditions follows the page's DC, with no DC of its own and no default (W7B-P-4)", () => {
    const sunburst = areaFill(dice(), { spell: "Sunburst" })!;
    assert.equal(sunburst.dc, null, "no caster, so no DC");
    assert.deepEqual(sunburst.outcome.saveEnds, { ability: "con", dc: null });
    assert.deepEqual(areaFill(dice(), { spell: "Sunburst", casterId: "cultist" })!.outcome.saveEnds, { ability: "con", dc: null });
  });

  test("a preset everyone takes opens as No save, and an area with no preset fills nothing", () => {
    assert.deepEqual(areaFill(dice(), { spell: "Spike Growth" })!.test, { kind: "none" });
    assert.equal(areaFill(dice(), { spell: "A homebrew blast" }), null);
  });
});

describe("a save action's fill", () => {
  test("a spell's row starts Against a spell, with half or none as the stat block resolves it (W7B-P-2, W7B-P-3)", () => {
    const d = dice();
    for (const key of ["fb2", "ray"]) {
      const named = pcNamedRolls(d.view.characters.wren!).find((r) => r.key === key)!;
      const fill = actionFill(d, named, { key: "t:wrenTok", tokenId: "wrenTok" })!;
      assert.equal(fill.spell, true);
      assert.equal(fill.outcome.onPass, named.save!.onPass);
    }
  });

  test("an unset cantrip with no SRD area rule, such as Sacred Flame, takes none (W7B-P-2)", () => {
    const d = dice();
    const named = pcNamedRolls(d.view.characters.wren!).find((r) => r.key === "sf")!;
    assert.equal(actionFill(d, named, { key: "t:wrenTok", tokenId: "wrenTok" })!.outcome.onPass, "none");
  });

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
    assert.deepEqual([fill.test, fill.dc, fill.outcome.damage, fill.outcome.conditions, fill.outcome.lasts?.mode, fill.outcome.lasts?.anchor], [{ kind: "save", ability: "con" }, 17, "3d6 Thunder", ["deafened"], "turnEnd", "own"]);
    assert.equal(fill.spell, false, "a breath is no spell");
    assert.equal(fill.fill.from, "From Thunderclap: Constitution save, DC 17, 3d6 Thunder, none on a pass, Deafened on a fail.");
  });
});
