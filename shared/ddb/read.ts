import { parseFormula, type DiceTerm, type Formula } from "../dice/formula.ts";
import { uuidv7 } from "../ids.ts";
import { ABILITY_KEYS, SKILL_KEYS, type AbilityKey, type Actor, type PcDice, type PcRoll, type PcStats, type SkillKey } from "../model.ts";
import { MAX_PC_DICE_PARTS, MAX_PC_ROLLS } from "../protocol.ts";
import { DAMAGE_TYPES, type DamageType } from "../rules/damage.ts";
import type { PcFill } from "../rules/pcFill.ts";
import { cantripTier, pcProficiency } from "../rules/pcStats.ts";
import { abilityMod } from "../statBlock.ts";
import { ddbSheetUrl } from "./link.ts";

/**
 * A D&D Beyond character's JSON read into a fill (docs/design-v1-pc-stats.md
 * 6.3 and Appendix B), on the server for a share link and in the browser
 * for pasted JSON, by the same code. It reads named paths of the JSON and
 * never walks the tree, bounds every list it loops over, and never throws.
 * It reads numbers, ability ids, damage type names and the names of
 * classes, weapons and spells, and never a description, snippet, note or
 * any other text, so no D&D Beyond prose and no HTML enters a room. What it
 * cannot read becomes a warning, and the editor keeps what it had.
 *
 * The paths were checked against a live public character's JSON during the
 * build. D&D Beyond's format is a third party's and can change, so every
 * read is tolerant: a missing or mistyped value is skipped, never assumed.
 */

type Obj = Record<string, unknown>;

/** Bounds on every list the reader loops over, well past any real character. */
const MAX = { modifiers: 600, classes: 20, features: 300, inventory: 400, properties: 20, spells: 400, actions: 200, defs: 20 };

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function arr(v: unknown, max: number): unknown[] {
  return Array.isArray(v) ? v.slice(0, max) : [];
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A name D&D Beyond gives, as one line of at most `max` characters with no control or text direction characters. */
function name(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const clean = v.replace(/[\p{Cc}\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, " ").replace(/\s+/g, " ").trim();
  if (clean === "") return null;
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

const ABILITY_BY_ID: Record<number, AbilityKey> = { 1: "str", 2: "dex", 3: "con", 4: "int", 5: "wis", 6: "cha" };
const ABILITY_SLUG: Record<AbilityKey, string> = { str: "strength", dex: "dexterity", con: "constitution", int: "intelligence", wis: "wisdom", cha: "charisma" };
const SKILL_SET = new Set<string>(SKILL_KEYS);
const DAMAGE_SET = new Set<string>(DAMAGE_TYPES);

function abilityOf(id: unknown): AbilityKey | null {
  const n = num(id);
  return n !== null ? (ABILITY_BY_ID[n] ?? null) : null;
}

function damageType(v: unknown): DamageType | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return DAMAGE_SET.has(t) ? (t as DamageType) : null;
}

/** A dice string as a part's formula: D&D Beyond writes "1d4 + 1". Null when it is not one the stat block holds. */
function formula(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const text = v.replace(/\s+/g, "");
  if (text === "" || text.length > 40 || !/^[0-9dkhl%+\-]+$/i.test(text)) return null;
  return parseFormula(text).ok ? text : null;
}

function diceTerms(f: Formula): DiceTerm[] {
  return f.filter((t): t is DiceTerm => t.kind === "dice");
}

type Modifier = { type: string; subType: string; value: number | null; statId: AbilityKey | null };

/**
 * Every modifier that applies: the race's, class's, background's, feat's
 * and condition's, and an item's only while its item is equipped, and
 * attuned where it needs attunement (Appendix B, Items).
 */
function modifiersOf(data: Obj): Modifier[] {
  const groups = obj(data.modifiers) ?? {};
  const equipped = new Map<number, { attuned: boolean }>();
  for (const raw of arr(data.inventory, MAX.inventory)) {
    const item = obj(raw);
    const id = num(obj(item?.definition)?.id);
    if (item && id !== null && item.equipped === true) equipped.set(id, { attuned: item.isAttuned === true });
  }
  const out: Modifier[] = [];
  for (const [group, list] of Object.entries(groups).slice(0, 10)) {
    for (const raw of arr(list, MAX.modifiers)) {
      const m = obj(raw);
      if (!m || typeof m.type !== "string" || typeof m.subType !== "string") continue;
      if (group === "item") {
        const holder = equipped.get(num(m.componentId) ?? -1);
        if (!holder || (m.requiresAttunement === true && !holder.attuned)) continue;
      }
      out.push({ type: m.type, subType: m.subType, value: num(m.fixedValue) ?? num(m.value), statId: abilityOf(m.statId) });
    }
  }
  return out;
}

function sumOf(mods: readonly Modifier[], type: string, subType: string, scoreMods: Record<AbilityKey, number> | null): number {
  let total = 0;
  for (const m of mods) {
    if (m.type !== type || m.subType !== subType) continue;
    // A bonus of an ability's modifier, as an Aura of Protection's, names the ability instead of a value.
    if (m.value !== null) total += m.value;
    else if (m.statId && scoreMods) total += Math.max(1, scoreMods[m.statId]);
  }
  return total;
}

function has(mods: readonly Modifier[], type: string, subType: string): boolean {
  return mods.some((m) => m.type === type && m.subType === subType);
}

/** The scores: base, the sheet's own bonus, each "<ability>-score" bonus, a "set" that raises one, and an override over all. */
function scoresOf(data: Obj, mods: readonly Modifier[], warnings: string[]): Record<AbilityKey, number> | null {
  const byId = (list: unknown) => {
    const out: Partial<Record<AbilityKey, number>> = {};
    for (const raw of arr(list, 12)) {
      const s = obj(raw);
      const a = abilityOf(s?.id);
      const v = num(s?.value);
      if (a && v !== null) out[a] = v;
    }
    return out;
  };
  const base = byId(data.stats);
  if (ABILITY_KEYS.some((a) => base[a] === undefined)) return null;
  const bonus = byId(data.bonusStats);
  const override = byId(data.overrideStats);
  const out = {} as Record<AbilityKey, number>;
  for (const a of ABILITY_KEYS) {
    let score = base[a]! + (bonus[a] ?? 0) + sumOf(mods, "bonus", `${ABILITY_SLUG[a]}-score`, null);
    for (const m of mods) if (m.type === "set" && m.subType === `${ABILITY_SLUG[a]}-score` && m.value !== null) score = Math.max(score, m.value);
    score = override[a] ?? score;
    out[a] = Math.min(30, Math.max(1, Math.round(score)));
  }
  if (mods.some((m) => m.subType === "choose-an-ability-score")) warnings.push("An ability score increase chosen in D&D Beyond may not have been read. Check the scores.");
  return out;
}

type ClassRead = { name: string; level: number; spellAbility: AbilityKey | null; features: Set<string> };

function classesOf(data: Obj): ClassRead[] {
  const out: ClassRead[] = [];
  for (const raw of arr(data.classes, MAX.classes)) {
    const c = obj(raw);
    const def = obj(c?.definition);
    const level = num(c?.level);
    if (!c || !def || level === null) continue;
    const features = new Set<string>();
    for (const f of arr(c.classFeatures, MAX.features)) {
      const fdef = obj(obj(f)?.definition);
      const fname = name(fdef?.name, 60);
      const at = num(fdef?.requiredLevel) ?? 1;
      // A feature counts once the class's level reaches the feature's.
      if (fname && at <= level) features.add(fname.toLowerCase());
    }
    out.push({
      name: name(def.name, 40) ?? "A class",
      level: Math.max(0, Math.round(level)),
      spellAbility: abilityOf(def.spellCastingAbilityId) ?? abilityOf(obj(c.subclassDefinition)?.spellCastingAbilityId),
      features,
    });
  }
  return out;
}

/**
 * AC from the armor and shield worn (Appendix B): light armor adds the
 * Dexterity modifier, medium at most +2, heavy none, a shield its own,
 * then every bonus to armor class. Always a line to check, since features
 * such as Unarmored Defense are not read.
 */
function acOf(data: Obj, mods: readonly Modifier[], dex: number): number {
  let armor: number | null = null;
  let shield = 0;
  for (const raw of arr(data.inventory, MAX.inventory)) {
    const item = obj(raw);
    const def = obj(item?.definition);
    if (!item || !def || item.equipped !== true) continue;
    const ac = num(def.armorClass);
    const type = num(def.armorTypeId);
    if (ac === null || type === null) continue;
    if (type === 4) shield = Math.max(shield, ac);
    else if (type === 1) armor = Math.max(armor ?? 0, ac + dex);
    else if (type === 2) armor = Math.max(armor ?? 0, ac + Math.min(2, dex));
    else if (type === 3) armor = Math.max(armor ?? 0, ac);
  }
  return Math.min(100, Math.max(0, (armor ?? 10 + dex) + shield + sumOf(mods, "bonus", "armor-class", null)));
}

function speedsOf(data: Obj): Actor["speeds"] | null {
  const normal = obj(obj(obj(data.race)?.weightSpeeds)?.normal);
  const walk = num(normal?.walk);
  if (!normal || walk === null) return null;
  const out: Actor["speeds"] = { walk: Math.min(1000, Math.max(0, Math.round(walk))) };
  for (const kind of ["fly", "swim", "climb", "burrow"] as const) {
    const v = num(normal[kind]);
    if (v !== null && v > 0) out[kind] = Math.min(1000, Math.round(v));
  }
  return out;
}

type Ctx = { scores: Record<AbilityKey, number>; level: number; warnings: string[]; newId: () => string };

function weaponRolls(data: Obj, ctx: Ctx, sneak: string | null): PcRoll[] {
  const out: PcRoll[] = [];
  const { scores } = ctx;
  for (const raw of arr(data.inventory, MAX.inventory)) {
    const item = obj(raw);
    const def = obj(item?.definition);
    if (!item || !def || item.equipped !== true || def.filterType !== "Weapon") continue;
    const wname = name(def.name, 48);
    const dice = formula(obj(def.damage)?.diceString);
    if (!wname || !dice) continue;
    const props = new Set(arr(def.properties, MAX.properties).map((p) => (name(obj(p)?.name, 30) ?? "").toLowerCase()));
    const ranged = num(def.attackType) === 2;
    const finesse = props.has("finesse");
    const ability: AbilityKey = finesse ? (scores.dex >= scores.str ? "dex" : "str") : ranged ? "dex" : "str";
    let magic = 0;
    for (const g of arr(def.grantedModifiers, MAX.modifiers)) {
      const m = obj(g);
      if (m?.type === "bonus" && m.subType === "magic") magic += num(m.fixedValue) ?? num(m.value) ?? 0;
    }
    const type = damageType(def.damageType);
    const part = (f: string): PcDice => ({ formula: magic ? `${f}+${magic}` : f, mod: true, ...(type ? { type } : {}) });
    const rider: PcDice[] = sneak && type && (finesse || ranged) ? [{ formula: sneak, type, optional: true, name: "Sneak Attack" }] : [];
    const attack = { prof: true, bonus: Math.max(-20, Math.min(20, magic)) };
    out.push({ id: ctx.newId(), name: wname, kind: "weapon", ability, attack, dice: [part(dice), ...rider], ddb: true });
    if (props.has("versatile")) {
      const versatile = arr(def.properties, MAX.properties).map(obj).find((p) => (name(p?.name, 30) ?? "").toLowerCase() === "versatile");
      const two = formula(versatile?.notes);
      if (two) out.push({ id: ctx.newId(), name: `${wname} (two hands)`, kind: "weapon", ability, attack, dice: [part(two), ...rider], ddb: true });
    }
  }
  return out;
}

/** A damage or healing modifier's dice at the character's level, and how it grows: a cantrip by the tier rule, a spell per slot. */
function spellPart(m: Obj, scale: string | null, level: number, spellLevel: number, ctx: Ctx, spellName: string): { part: PcDice; dice: string } | null {
  let dice = formula(obj(m.die)?.diceString);
  if (!dice) return null;
  const defs = arr(obj(m.atHigherLevels)?.higherLevelDefinitions, MAX.defs).map(obj).filter((d): d is Obj => d !== null);
  const part: PcDice = { formula: dice };
  if (m.usePrimaryStat === true) part.mod = true;
  if (spellLevel === 0 && scale === "characterlevel" && defs.length > 0) {
    const base = parseFormula(dice);
    // A cantrip whose dice follow the tier rule grows. Any other scaling is read at the character's level.
    const follows =
      base.ok &&
      defs.every((d) => {
        const at = num(d.level);
        const f = parseFormula(formula(obj(d.dice)?.diceString) ?? "");
        if (at === null || !f.ok) return false;
        const want = diceTerms(base.formula);
        const got = diceTerms(f.formula);
        return got.length === want.length && got.every((t, i) => t.sides === want[i]!.sides && t.count === want[i]!.count * cantripTier(at));
      });
    if (follows) part.grows = true;
    else {
      const reached = defs.filter((d) => (num(d.level) ?? 99) <= level).sort((a, b) => (num(b.level) ?? 0) - (num(a.level) ?? 0))[0];
      const at = formula(obj(reached?.dice)?.diceString);
      if (at) {
        dice = at;
        part.formula = at;
      }
      ctx.warnings.push(`${spellName}'s dice were read at level ${level}. Check them after a level-up.`);
    }
  } else if (spellLevel >= 1 && scale === "spellscale" && defs.length > 0) {
    const per = defs.find((d) => num(d.level) === 1);
    const upcast = formula(obj(per?.dice)?.diceString);
    if (upcast && upcast.length <= 20) part.upcast = upcast;
    else ctx.warnings.push(`How ${spellName} grows with a higher slot was not read. Check At higher levels.`);
  }
  return { part, dice };
}

function spellRolls(data: Obj, ctx: Ctx, casting: AbilityKey | null): { rolls: PcRoll[]; unhalved: string[] } {
  const entries: { entry: Obj; granted: boolean }[] = [];
  for (const raw of arr(data.classSpells, MAX.classes)) for (const s of arr(obj(raw)?.spells, MAX.spells)) entries.push({ entry: obj(s) ?? {}, granted: false });
  const groups = obj(data.spells) ?? {};
  for (const key of ["race", "class", "item", "feat"]) for (const s of arr(groups[key], MAX.spells)) entries.push({ entry: obj(s) ?? {}, granted: true });
  const seen = new Set<string>();
  const rolls: PcRoll[] = [];
  const unhalved: string[] = [];
  for (const { entry, granted } of entries.slice(0, MAX.spells)) {
    const def = obj(entry.definition);
    const sname = name(def?.name, 60);
    const level = num(def?.level);
    if (!def || !sname || level === null || level < 0 || level > 9) continue;
    // Prepared, always prepared, known, cantrips, and what a race, item or feat grants.
    const usable = granted || level === 0 || entry.prepared === true || entry.alwaysPrepared === true || entry.countsAsKnownSpell === true;
    const key = `${sname.toLowerCase()}:${level}`;
    if (!usable || seen.has(key)) continue;
    const scale = typeof def.scaleType === "string" ? def.scaleType : null;
    const parts: PcDice[] = [];
    const typed: { type: DamageType; dice: string }[] = [];
    for (const raw of arr(def.modifiers, MAX.modifiers)) {
      const m = obj(raw);
      if (!m) continue;
      const healing = m.type === "bonus" && m.subType === "hit-points";
      const type = m.type === "damage" ? damageType(m.subType) : null;
      if (!healing && !type) continue;
      const read = spellPart(m, scale, ctx.level, level, ctx, sname);
      if (!read) continue;
      if (type) typed.push({ type, dice: read.dice });
      parts.push({ ...read.part, type: healing ? "healing" : type! });
    }
    // Three or more types with the same dice are a choice, as Chromatic Orb's: the first is read, and the caster picks.
    const choice = typed.length >= 3 && typed.every((t) => t.dice === typed[0]!.dice);
    let dice = parts;
    if (choice) {
      const first = parts.findIndex((p) => p.type !== "healing");
      dice = parts.filter((p, i) => p.type === "healing" || i === first);
      const read = dice.find((p) => p.type !== "healing")?.type;
      ctx.warnings.push(`${sname} deals one of several damage types. ${read ? `${read[0]!.toUpperCase()}${read.slice(1)}` : "The first"} was read. Change it as you cast.`);
    }
    if (dice.length > MAX_PC_DICE_PARTS) {
      ctx.warnings.push(`${sname} has more dice than a roll holds, so some were left out.`);
      dice = dice.slice(0, MAX_PC_DICE_PARTS);
    }
    const attack = def.requiresAttackRoll === true;
    const saveAbility = def.requiresSavingThrow === true ? abilityOf(def.saveDcAbilityId) : null;
    if (!attack && !saveAbility && dice.length === 0) continue;
    seen.add(key);
    const own = abilityOf(entry.spellCastingAbilityId);
    const roll: PcRoll = { id: ctx.newId(), name: sname, kind: "spell", ability: own && own !== casting ? own : "spell", level, dice, ddb: true };
    if (attack) roll.attack = { prof: true, bonus: 0 };
    if (saveAbility) {
      roll.save = { ability: saveAbility };
      if (dice.some((p) => p.type !== undefined && p.type !== "healing")) unhalved.push(sname);
    }
    rolls.push(roll);
  }
  return { rolls, unhalved };
}

function actionRolls(data: Obj, ctx: Ctx): PcRoll[] {
  const out: PcRoll[] = [];
  const groups = obj(data.actions) ?? {};
  for (const key of ["race", "class", "feat"]) {
    for (const raw of arr(groups[key], MAX.actions)) {
      const a = obj(raw);
      const aname = name(a?.name, 60);
      if (!a || !aname) continue;
      const dice = formula(obj(a.dice)?.diceString);
      const save = abilityOf(a.saveStatId);
      if (!dice && !save) continue;
      const roll: PcRoll = { id: ctx.newId(), name: aname, kind: "other", dice: dice ? [{ formula: dice }] : [], ddb: true };
      const ability = abilityOf(a.abilityModifierStatId);
      if (ability) roll.ability = ability;
      if (save) {
        const fixed = num(a.fixedSaveDc);
        roll.save = fixed !== null && fixed >= 1 && fixed <= 50 ? { ability: save, dc: Math.round(fixed) } : { ability: save };
      }
      out.push(roll);
    }
  }
  return out;
}

function clampAdjust(n: number): number {
  return Math.max(-20, Math.min(20, Math.round(n)));
}

/**
 * A D&D Beyond character's JSON, the `{ success, data }` envelope or the
 * bare `data`, as a fill, or null when it does not read as a character.
 * Never throws.
 */
export function readDdbCharacter(json: unknown, newId: () => string = () => uuidv7()): PcFill | null {
  try {
    return read(json, newId);
  } catch {
    return null;
  }
}

function read(json: unknown, newId: () => string): PcFill | null {
  const top = obj(json);
  if (!top) return null;
  const data = obj(top.data) ?? top;
  const warnings: string[] = [];
  const mods = modifiersOf(data);
  const scores = scoresOf(data, mods, warnings);
  if (!scores) return null;
  const scoreMods = {} as Record<AbilityKey, number>;
  for (const a of ABILITY_KEYS) scoreMods[a] = abilityMod(scores[a]);

  const classes = classesOf(data);
  let level = classes.reduce((sum, c) => sum + c.level, 0);
  if (level > 20) {
    warnings.push(`The classes' levels add up to ${level}, past 20, so the level reads 20.`);
    level = 20;
  }
  level = Math.max(1, level);
  // The level's proficiency is what every other number derives from, so a sheet without classes says so.
  if (classes.length === 0) warnings.push(`No class was read, so the level reads 1 and proficiency +${pcProficiency(1)}.`);

  const saves = ABILITY_KEYS.filter((a) => has(mods, "proficiency", `${ABILITY_SLUG[a]}-saving-throws`));
  const skills: PcStats["skills"] = {};
  for (const m of mods) {
    if (!SKILL_SET.has(m.subType)) continue;
    const s = m.subType as SkillKey;
    if (m.type === "expertise") skills[s] = "expert";
    else if (m.type === "proficiency" && skills[s] !== "expert") skills[s] = "prof";
  }
  const adjust: PcStats["adjust"] = {};
  const saveAdjust: Partial<Record<AbilityKey, number>> = {};
  for (const a of ABILITY_KEYS) {
    const v = clampAdjust(sumOf(mods, "bonus", `${ABILITY_SLUG[a]}-saving-throws`, scoreMods));
    if (v !== 0) saveAdjust[a] = v;
  }
  if (Object.keys(saveAdjust).length > 0) adjust.saves = saveAdjust;
  const skillAdjust: Partial<Record<SkillKey, number>> = {};
  for (const s of SKILL_KEYS) {
    const v = clampAdjust(sumOf(mods, "bonus", s, scoreMods));
    if (v !== 0) skillAdjust[s] = v;
  }
  if (Object.keys(skillAdjust).length > 0) adjust.skills = skillAdjust;
  const field = (key: "allSaves" | "allChecks" | "init" | "passive" | "spellDc" | "spellAttack", subType: string) => {
    const v = clampAdjust(sumOf(mods, "bonus", subType, scoreMods));
    if (v !== 0) adjust[key] = v;
  };
  field("allSaves", "saving-throws");
  field("allChecks", "ability-checks");
  field("init", "initiative");
  field("passive", "passive-perception");
  field("spellDc", "spell-save-dc");
  field("spellAttack", "spell-attacks");

  const defenses: PcStats["defenses"] = {};
  const KIND = { resistance: "resistant", immunity: "immune", vulnerability: "vulnerable" } as const;
  for (const m of mods) {
    const kind = KIND[m.type as keyof typeof KIND];
    const type = damageType(m.subType);
    if (kind && type) defenses[type] = kind;
  }

  const caster = classes.find((c) => c.spellAbility !== null);
  const spellAbility = caster?.spellAbility ?? null;
  const hasFeature = (feature: string) => classes.find((c) => c.features.has(feature.toLowerCase()));
  const rogue = hasFeature("Sneak Attack");
  const sneak = rogue ? `${Math.ceil(rogue.level / 2)}d6` : null;
  const critOn = hasFeature("Superior Critical") ? 18 : hasFeature("Improved Critical") ? 19 : null;
  const ctx: Ctx = { scores, level, warnings, newId };

  const weapons = weaponRolls(data, ctx, sneak);
  const spells = spellRolls(data, ctx, spellAbility);
  const actions = actionRolls(data, ctx);
  const all = [...weapons, ...spells.rolls, ...actions];
  if (spells.unhalved.length > 0) {
    warnings.push(`Whether a pass halves the damage was not read for ${spells.unhalved.slice(0, 8).join(", ")}${spells.unhalved.length > 8 ? " and others" : ""}. Set On a pass for each.`);
  }
  if (all.length > MAX_PC_ROLLS) warnings.push(`${all.length - MAX_PC_ROLLS} more ${all.length - MAX_PC_ROLLS === 1 ? "roll was" : "rolls were"} left out. At most ${MAX_PC_ROLLS} rolls fit.`);

  const actor: PcFill["actor"] = {};
  const ac = acOf(data, mods, scoreMods.dex);
  actor.ac = ac;
  warnings.push(`AC ${ac} was worked out from the armor. Check it.`);
  const override = num(data.overrideHitPoints);
  const baseHp = num(data.baseHitPoints);
  if (override !== null && override >= 1) actor.hpMax = Math.min(100_000, Math.round(override));
  else if (baseHp !== null) {
    const hp = baseHp + (num(data.bonusHitPoints) ?? 0) + (scoreMods.con + sumOf(mods, "bonus", "hit-points-per-level", scoreMods)) * level;
    if (hp >= 1) actor.hpMax = Math.min(100_000, Math.round(hp));
  }
  const speeds = speedsOf(data);
  if (speeds) actor.speeds = speeds;
  const darkvision = Math.max(0, ...mods.filter((m) => m.type === "set-base" && m.subType === "darkvision" && m.value !== null).map((m) => m.value!));
  actor.senses = darkvision > 0 ? `Darkvision ${Math.min(1000, Math.round(darkvision))} ft.` : "";
  const id = num(data.id);
  if (id !== null && Number.isInteger(id) && id > 0 && id < 1e12) actor.sheetUrl = ddbSheetUrl(String(id));

  const fill: PcFill = {
    source: "ddb",
    stats: {
      abilities: scores,
      saves,
      skills,
      adjust,
      defenses,
      spellAbility,
      jack: has(mods, "half-proficiency", "ability-checks"),
      alert: has(mods, "proficiency", "initiative"),
      evasion: hasFeature("Evasion") !== undefined,
      critOn,
      rolls: all.slice(0, MAX_PC_ROLLS),
    },
    level,
    actor,
    warnings: warnings.slice(0, 40),
  };
  const cname = name(data.name, 80);
  if (cname) fill.name = cname;
  return fill;
}
