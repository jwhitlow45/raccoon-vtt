import type { NamedRoll } from "#shared/dice/bonus.ts";
import { formatFormula, parseFormula } from "#shared/dice/formula.ts";
import type { AreaTemplate, Character, Trap } from "#shared/model.ts";
import { cantripTier, pcNamedRolls, pcSlots } from "#shared/rules/pcStats.ts";
import { damageTypeName, type DamageType } from "#shared/rules/damage.ts";
import { ABILITY_NAMES } from "#shared/rules/skills.ts";
import { AREA_SPELLS, type AreaSpell } from "#shared/srd/area-spells.ts";
import { effectName } from "#shared/logText.ts";
import { creatureRolls, type DiceView } from "../creature.ts";
import { initiativeRow } from "../options.ts";
import type { Fill, OutcomeForm } from "./chain.ts";
import type { GroupTest } from "./rows.ts";

/**
 * Where a group save's fields start (docs/design-v1-roll-options.md 5.6 and
 * Appendix C's fill order): a save action, an area's spell preset and its
 * caster, each field from the first source that knows it, and the fill
 * line that says where they came from. The DM may change any of them.
 */

export type FillInput = { test: GroupTest; dc: number | null; fill: Fill; outcome: Partial<OutcomeForm>; spell: boolean };

type Part = { formula: string; type?: DamageType; perSlot?: string };

/** Dice times a count: a cantrip's dice at its caster's tier, "1d6" at tier 3 is "3d6". */
function times(formula: string, n: number): string {
  if (n === 1) return formula;
  const parsed = parseFormula(formula);
  if (!parsed.ok) return formula;
  return formatFormula(parsed.formula.map((t) => (t.kind === "dice" ? { ...t, count: t.count * n } : t)));
}

/** A part at a slot above its spell's level: its own dice and its per-slot dice that many times, joined where they match ("8d6" and "2d6" make "10d6"). */
function atSlot(part: Part, extra: number): string {
  if (!part.perSlot || extra <= 0) return part.formula;
  const parsed = parseFormula([part.formula, ...Array.from({ length: extra }, () => part.perSlot!)].join("+"));
  if (!parsed.ok) return part.formula;
  const merged: typeof parsed.formula = [];
  for (const t of parsed.formula) {
    const at = t.kind === "dice" && !t.keep ? merged.findIndex((m) => m.kind === "dice" && !m.keep && m.sign === t.sign && m.sides === t.sides) : -1;
    const found = merged[at];
    if (found && found.kind === "dice" && t.kind === "dice") merged[at] = { ...found, count: found.count + t.count };
    else merged.push(t);
  }
  return formatFormula(merged);
}

export function partsTextOf(parts: readonly Part[], slotExtra = 0): string {
  return parts.map((p) => `${atSlot(p, slotExtra)}${p.type ? ` ${damageTypeName(p.type)}` : ""}`).join(" + ");
}

/** The fill line: "From Fireball: Dexterity save, DC 15, 8d6 Fire, half on a pass." `rolled` follows the damage: "rolled 31 (Thorn's roll)". */
export function fromLine(name: string, test: GroupTest, dc: number | null, dcFrom: string | null, damage: string, onPass: "half" | "none", conditions: readonly string[], rolled?: string): string {
  const what = test.kind === "none" ? "No save" : test.kind === "save" ? `${ABILITY_NAMES[test.ability]} save` : `${ABILITY_NAMES[test.ability]} check`;
  const parts = [what];
  if (dc !== null) parts.push(`DC ${dc}${dcFrom ? ` (${dcFrom})` : ""}`);
  if (damage) parts.push(damage);
  if (damage && rolled) parts.push(rolled);
  if (damage && test.kind !== "none") parts.push(onPass === "half" ? "half on a pass" : "none on a pass");
  if (conditions.length > 0) parts.push(`${conditions.map(effectName).join(" and ")} on a fail`);
  return `From ${name}: ${parts.join(", ")}.`;
}

/** The character a token stands for, if any. */
function characterOf(dice: DiceView, tokenId: string | undefined): Character | undefined {
  const token = tokenId ? dice.view.tokens[tokenId] : undefined;
  return token && "ref" in token.actor ? dice.view.characters[token.actor.ref] : undefined;
}

/**
 * A save action's fill (5.6): its ability, DC, parts that are not optional,
 * half or none, conditions and how they end, and "Against a spell" for a
 * spell. The save that ends a condition takes the page's DC, as a repeated
 * save does, unless the DM types its own. With a `slot`, a leveled spell
 * keeps it, held at its own level or above, and a character's spell scales
 * its damage there as its row does (pcSlots).
 */
export function actionFill(dice: DiceView, named: NamedRoll, actor: { key: string; tokenId?: string }, slot?: number): FillInput | null {
  const save = named.save;
  if (!save) return null;
  const level = named.section === "spells" && named.level !== undefined && named.level >= 1 ? named.level : undefined;
  const pick = slot !== undefined && level !== undefined ? Math.max(level, Math.min(9, Math.floor(slot))) : undefined;
  const character = characterOf(dice, actor.tokenId);
  const scaled = pick !== undefined && level !== undefined && pick > level && character ? (pcSlots(character, named.key)?.at(pick) ?? named) : named;
  const parts: Part[] = scaled.damage.filter((p) => !p.optional).map((p) => ({ formula: p.formula, ...(p.type ? { type: p.type } : {}) }));
  const damage = partsTextOf(parts);
  const conditions = named.conditions ?? [];
  const test: GroupTest = { kind: "save", ability: save.ability };
  const actingRow = actor.tokenId ? initiativeRow(dice.view, { tokenId: actor.tokenId }) : undefined;
  // A character's spell arrives with its pass resolved by its stat block (pcNamedRolls): typed or read, else the SRD's rule by name. One rule, kept there.
  const onPass = save.onPass;
  return {
    test,
    dc: save.dc,
    spell: named.section === "spells",
    fill: {
      name: named.name,
      from: fromLine(named.name, test, save.dc, null, damage, onPass, conditions),
      ...(named.recharge !== undefined ? { recharge: { holder: actor.key, key: named.key } } : {}),
      ...(parts[0]?.type ? { damageType: parts[0].type } : {}),
      ...(actor.tokenId ? { caster: actor.tokenId } : {}),
    },
    outcome: {
      damage,
      onPass,
      conditions,
      lasts: named.lasts ? { mode: named.lasts.at === "start" ? "turnStart" : "turnEnd", rounds: 10, anchor: named.lasts.of === "self" && actingRow ? actingRow.id : "own" } : { mode: "none", rounds: 10, anchor: "own" },
      saveEnds: named.saveEnds ? { ability: save.ability, dc: null } : null,
      ...(pick !== undefined ? { slot: pick } : {}),
    },
  };
}

/** The caster's own spell of this name: a character's from its stat block (doc 2), to scale by its slots. */
function ownSpell(character: Character | undefined, name: string): NamedRoll | undefined {
  if (!character) return undefined;
  return pcNamedRolls(character).find((r) => r.section === "spells" && r.name.trim().toLowerCase() === name.trim().toLowerCase());
}

/**
 * An area's fill (5.6): the preset whose name the area keeps, the DC from
 * its caster's spell save DC (a character's stat block, a monster's
 * Spellcasting), the damage from the caster character's own spell of that
 * name, else the preset's at its level, a cantrip's dice at its caster
 * character's tier. A preset with no save opens as No save, and "Against a
 * spell" starts on.
 */
export function areaFill(dice: DiceView, template: Pick<AreaTemplate, "spell" | "casterId" | "label">, slot?: number): FillInput | null {
  const preset: AreaSpell | undefined = template.spell ? AREA_SPELLS.find((s) => s.name === template.spell) : undefined;
  if (!preset) return null;
  const caster = template.casterId ? dice.view.tokens[template.casterId] : undefined;
  const casterChar = characterOf(dice, template.casterId);
  const numbers = caster ? creatureRolls(dice, { tokenId: caster.id })?.numbers : null;
  const own = ownSpell(casterChar, preset.name);
  const test: GroupTest = preset.noSave ? { kind: "none" } : preset.save ? { kind: "save", ability: own?.save?.ability ?? preset.save } : { kind: "save", ability: "dex" };
  const dc = own?.save?.dc ?? numbers?.spellDc ?? null;
  const dcFrom = dc === null ? null : `${caster ? (casterChar?.name ?? caster.name) : "the caster"}'s spell save DC`;
  const level = own?.level ?? preset.level;
  const pick = Math.max(level, Math.min(9, slot ?? level));
  let parts: Part[];
  if (own && own.damage.length > 0) {
    const scaled = casterChar && pick > level ? (pcSlots(casterChar, own.key)?.at(pick) ?? own) : own;
    parts = scaled.damage.filter((p) => !p.optional).map((p) => ({ formula: p.formula, ...(p.type ? { type: p.type } : {}) }));
  } else {
    const tier = preset.cantrip && casterChar ? cantripTier(casterChar.level) : 1;
    parts = (preset.damage ?? []).map((p) => ({ formula: atSlot({ ...p, formula: times(p.formula, tier), perSlot: p.perSlot }, pick - level), type: p.type }));
  }
  const damage = partsTextOf(parts);
  // The caster's own spell as its stat block resolves it, typed or read before the SRD's rule (pcNamedRolls). A caster without it takes the preset's.
  const onPass = own?.save?.onPass ?? preset.onPass ?? "half";
  const conditions = preset.conditions ?? [];
  const casterRow = caster ? initiativeRow(dice.view, { tokenId: caster.id }) : undefined;
  return {
    test,
    dc,
    spell: true,
    fill: {
      name: preset.name,
      from: fromLine(preset.name, test, dc, dcFrom, damage, onPass, conditions),
      ...(parts[0]?.type ? { damageType: parts[0].type } : {}),
      ...(template.casterId ? { caster: template.casterId } : {}),
    },
    outcome: {
      damage,
      onPass,
      conditions,
      ...(level > 0 && (preset.damage?.some((p) => p.perSlot) || own) ? { slot: pick } : {}),
      lasts: preset.lasts ? { mode: preset.lasts.at === "start" ? "turnStart" : "turnEnd", rounds: 10, anchor: preset.lasts.of === "self" && casterRow ? casterRow.id : "own" } : { mode: "none", rounds: 10, anchor: "own" },
      saveEnds: preset.saveEnds && preset.save ? { ability: preset.save, dc: null } : null,
    },
  };
}

/** The caster's save actions an area lists beside its preset: "Fill from Fire Breath". */
export function casterActions(dice: DiceView, template: Pick<AreaTemplate, "casterId">): NamedRoll[] {
  if (!template.casterId) return [];
  return creatureRolls(dice, { tokenId: template.casterId })?.named.filter((r) => r.save !== undefined) ?? [];
}

/** What players call a trap (docs/design-v1-traps.md 4.4): its name once found, else only "Trap". */
export const UNFOUND_TRAP = "Trap";

/**
 * A trap's fill (docs/design-v1-traps.md 4.4): its save or No save, so a
 * pit applies in one tap, its DC, damage, half or none, conditions on a
 * fail and how long they last, and "Against a spell" off. The page and its
 * line name the trap. What players read names it only once they found it.
 * The DM note goes under the line, as it says what the page cannot know
 * ("succeeds automatically if it's Huge or larger: mark those Pass").
 */
export function trapFill(trap: Pick<Trap, "name" | "found" | "rig">): FillInput {
  const rig = trap.rig;
  const test: GroupTest = rig?.save ? { kind: "save", ability: rig.save.ability } : { kind: "none" };
  const dc = rig?.save?.dc ?? null;
  const parts: Part[] = (rig?.damage ?? []).map((d) => ({ formula: d.formula, type: d.type }));
  const damage = partsTextOf(parts);
  const onPass = rig?.save?.onPass ?? "half";
  const conditions = [...(rig?.conditions ?? [])];
  const lasts = rig?.lasts;
  return {
    test,
    dc,
    spell: false,
    fill: {
      name: trap.name,
      publicName: trap.found ? trap.name : UNFOUND_TRAP,
      from: fromLine(trap.name, test, dc, null, damage, onPass, conditions),
      ...(rig?.note ? { note: rig.note } : {}),
      ...(parts[0]?.type ? { damageType: parts[0].type } : {}),
    },
    outcome: {
      damage,
      onPass,
      conditions,
      lasts: lasts ? { mode: lasts.mode, rounds: lasts.rounds ?? 10, anchor: "own" } : { mode: "none", rounds: 10, anchor: "own" },
      saveEnds: null,
    },
  };
}
