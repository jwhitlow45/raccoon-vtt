import { parseFormula, type DiceTerm, type Formula } from "../dice/formula.ts";
import { uuidv7 } from "../ids.ts";
import { ABILITY_KEYS, SKILL_KEYS, type AbilityKey, type Actor, type PcDice, type PcRoll, type PcStats, type SkillKey } from "../model.ts";
import { MAX_PC_DICE_PARTS, MAX_PC_ROLLS } from "../protocol.ts";
import { DAMAGE_TYPES, type DamageType } from "../rules/damage.ts";
import type { PcFill, PcFillStats } from "../rules/pcFill.ts";
import { cantripTier, srdOnPass } from "../rules/pcStats.ts";
import { abilityMod } from "../statBlock.ts";
import { ddbSheetUrl } from "./link.ts";
import { actionsWhole, readResources } from "./resources.ts";

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
 * Each output is read only when every source it depends on came with the
 * right type (docs/design-v1-resync.md 2.5). A source the JSON lacks leaves
 * its outputs out of the fill, so they stay as they are. Read as empty, a
 * sheet sent without its inventory would say the character owns no
 * weapons, and a re-sync would remove them.
 *
 * The paths were checked against a live public character's JSON during the
 * build. D&D Beyond's format is a third party's and can change, so every
 * read is tolerant: a missing or mistyped value is skipped, never assumed.
 *
 * The class resources, read from the limited uses of the same actions,
 * are read by ./resources.ts (docs/design-v1-ddb-resources.md).
 */

type Obj = Record<string, unknown>;

/** Bounds on every list the reader loops over, well past any real character. */
const MAX = { modifiers: 600, classes: 20, features: 300, inventory: 400, properties: 20, spells: 400, actions: 200, defs: 20 };

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

/**
 * Whether a list was read to its end: null, absent, or a list within its
 * bound. A list cut at its bound, or not a list, may hold a linked roll, so
 * its kind is not read whole and a merge never removes one because of it
 * (docs/design-v1-resync.md 2.5, DDBBUILD-ASTRA-01).
 */
function wholeList(v: unknown, max: number): boolean {
  return v === null || v === undefined || (Array.isArray(v) && v.length <= max);
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

/** Each ability's value in a list of `{ id, value }`, the shape of the sheet's scores, their bonuses and their overrides. */
function byAbility(list: unknown): Partial<Record<AbilityKey, number>> {
  const out: Partial<Record<AbilityKey, number>> = {};
  for (const raw of arr(list, 12)) {
    const s = obj(raw);
    const a = abilityOf(s?.id);
    const v = num(s?.value);
    if (a && v !== null) out[a] = v;
  }
  return out;
}

/** The six base scores, or null without one of them, since then the JSON does not read as a character at all. */
function baseScoresOf(data: Obj): Record<AbilityKey, number> | null {
  const given = byAbility(data.stats);
  const out = {} as Record<AbilityKey, number>;
  for (const a of ABILITY_KEYS) {
    const v = given[a];
    if (v === undefined) return null;
    out[a] = v;
  }
  return out;
}

/** The scores: base, the sheet's own bonus, each "<ability>-score" bonus, a "set" that raises one, and an override over all. */
function scoresOf(base: Record<AbilityKey, number>, data: Obj, mods: readonly Modifier[], warnings: string[]): Record<AbilityKey, number> {
  const bonus = byAbility(data.bonusStats);
  const override = byAbility(data.overrideStats);
  const out = {} as Record<AbilityKey, number>;
  for (const a of ABILITY_KEYS) {
    let score = base[a] + (bonus[a] ?? 0) + sumOf(mods, "bonus", `${ABILITY_SLUG[a]}-score`, null);
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
 * then every bonus to armor class. The review's AC line always asks the
 * player to check it, since features such as Unarmored Defense are not read.
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

type Ctx = { warnings: string[]; newId: () => string };

function weaponRolls(data: Obj, ctx: Ctx, scores: Record<AbilityKey, number>, sneak: string | null): PcRoll[] {
  const out: PcRoll[] = [];
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

function spellRolls(data: Obj, ctx: Ctx, characterLevel: number, casting: AbilityKey | null): { rolls: PcRoll[]; unhalved: string[]; whole: boolean } {
  const entries: { entry: Obj; granted: boolean }[] = [];
  let whole = wholeList(data.classSpells, MAX.classes);
  for (const raw of arr(data.classSpells, MAX.classes)) {
    whole &&= wholeList(obj(raw)?.spells, MAX.spells);
    for (const s of arr(obj(raw)?.spells, MAX.spells)) entries.push({ entry: obj(s) ?? {}, granted: false });
  }
  const groups = obj(data.spells) ?? {};
  for (const key of ["race", "class", "item", "feat"]) {
    whole &&= wholeList(groups[key], MAX.spells);
    for (const s of arr(groups[key], MAX.spells)) entries.push({ entry: obj(s) ?? {}, granted: true });
  }
  whole &&= entries.length <= MAX.spells;
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
      const read = spellPart(m, scale, characterLevel, level, ctx, sname);
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
      // D&D Beyond's data does not say whether a pass halves. The SRD's rule answers for its spells, so only the rest are named.
      if (dice.some((p) => p.type !== undefined && p.type !== "healing") && srdOnPass(roll) === undefined) unhalved.push(sname);
    }
    rolls.push(roll);
  }
  return { rolls, unhalved, whole };
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

function savesOf(mods: readonly Modifier[]): PcStats["saves"] {
  return ABILITY_KEYS.filter((a) => has(mods, "proficiency", `${ABILITY_SLUG[a]}-saving-throws`));
}

function skillsOf(mods: readonly Modifier[]): PcStats["skills"] {
  const skills: PcStats["skills"] = {};
  for (const m of mods) {
    if (!SKILL_SET.has(m.subType)) continue;
    const s = m.subType as SkillKey;
    if (m.type === "expertise") skills[s] = "expert";
    else if (m.type === "proficiency" && skills[s] !== "expert") skills[s] = "prof";
  }
  return skills;
}

function adjustOf(mods: readonly Modifier[], scoreMods: Record<AbilityKey, number>): PcStats["adjust"] {
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
  return adjust;
}

function defensesOf(mods: readonly Modifier[]): PcStats["defenses"] {
  const defenses: PcStats["defenses"] = {};
  const KIND = { resistance: "resistant", immunity: "immune", vulnerability: "vulnerable" } as const;
  for (const m of mods) {
    const kind = KIND[m.type as keyof typeof KIND];
    const type = damageType(m.subType);
    if (kind && type) defenses[type] = kind;
  }
  return defenses;
}

/** The character's level, the classes' sum, from 1 to 20. */
function levelOf(classes: readonly ClassRead[], warnings: string[]): number {
  const level = classes.reduce((sum, c) => sum + c.level, 0);
  if (level <= 20) return Math.max(1, level);
  warnings.push(`The classes' levels add up to ${level}, past 20, so the level reads 20.`);
  return 20;
}

/** Which sources the JSON holds with the type the reader needs (2.5). An empty list counts as sent. */
type Sent = {
  modifiers: boolean;
  /** Whether any item has modifiers, since only the inventory says which items are equipped. */
  itemModifiers: boolean;
  inventory: boolean;
  scoreChanges: boolean;
  classes: boolean;
  spellLists: boolean;
  actions: boolean;
};

function sentOf(data: Obj, classes: readonly ClassRead[]): Sent {
  const modifiers = obj(data.modifiers);
  const item = modifiers?.item;
  return {
    modifiers: modifiers !== null,
    itemModifiers: Array.isArray(item) && item.length > 0,
    inventory: Array.isArray(data.inventory),
    scoreChanges: Array.isArray(data.bonusStats) && Array.isArray(data.overrideStats),
    classes: classes.length > 0,
    spellLists: Array.isArray(data.classSpells) && obj(data.spells) !== null,
    actions: obj(data.actions) !== null,
  };
}

/** One warning per source the JSON lacks, naming everything left out because of it. */
function missingWarnings(sent: Sent): string[] {
  const out: string[] = [];
  if (!sent.classes) out.push("D&D Beyond did not send the character's classes, so the level, spellcasting, class features, max HP, weapons and spells were not read. They stay as they are.");
  if (!sent.modifiers) out.push("D&D Beyond did not send the character's bonuses and proficiencies, so the scores, proficiencies, bonuses, defenses, senses, AC, max HP and weapons were not read. They stay as they are.");
  if (!sent.inventory) {
    out.push(
      sent.itemModifiers
        ? "D&D Beyond did not send the equipment, so its magic items' bonuses could not be counted, and the scores, proficiencies, bonuses, defenses, senses, AC, max HP and weapons were not read. They stay as they are."
        : "D&D Beyond did not send the equipment, so AC and weapons were not read. They stay as they are.",
    );
  }
  if (!sent.scoreChanges) out.push("D&D Beyond did not send the bonuses and overrides to the ability scores, so the scores, bonuses, AC, max HP and weapons were not read. They stay as they are.");
  if (!sent.spellLists) out.push("D&D Beyond did not send the character's spell lists, so spells were not read. They stay as they are.");
  if (!sent.actions) out.push("D&D Beyond did not send the character's actions, so other rolls and class resources were not read. They stay as they are.");
  return out;
}

/**
 * The first 40 of the weapons, then the spells, then the other rolls, so
 * the fill and the sync record stay within a block's 40. A kind is read
 * whole only when it was read and the cut took none of it. A re-sync
 * removes linked rolls of a whole kind alone, so a roll it did not see is
 * never taken for one D&D Beyond removed.
 */
function cutRolls(weapon: PcRoll[] | null, spell: PcRoll[] | null, other: PcRoll[] | null): { rolls: PcRoll[]; read: NonNullable<PcFill["read"]>; over: number } {
  const rolls: PcRoll[] = [];
  let over = 0;
  const take = (kind: PcRoll[] | null): boolean => {
    if (!kind) return false;
    const room = MAX_PC_ROLLS - rolls.length;
    rolls.push(...kind.slice(0, room));
    over += Math.max(0, kind.length - room);
    return kind.length <= room;
  };
  const read = { weapon: take(weapon), spell: take(spell), other: take(other) };
  return { rolls, read, over };
}

function cutWarning(over: number, who: string): string {
  return over === 1
    ? `D&D Beyond has 1 more roll for ${who} than the ${MAX_PC_ROLLS} that are read, so it was not read. Rolls here that it would change stay as they are.`
    : `D&D Beyond has ${over} more rolls for ${who} than the ${MAX_PC_ROLLS} that are read, so those were not read. Rolls here that they would change stay as they are.`;
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
  const base = baseScoresOf(data);
  if (!base) return null;
  const cname = name(data.name, 80);
  const classes = classesOf(data);
  const sent = sentOf(data, classes);
  const warnings = missingWarnings(sent);
  // The class resources' lines go right after these, before the scores' and spells', so the 40-line cut never drops them (OP-13).
  const resourceLinesAt = warnings.length;

  // The modifiers' needs, then the scores' needs (2.5): every output below that reads a modifier or a score is read only when these are.
  const mods = sent.modifiers && (sent.inventory || !sent.itemModifiers) ? modifiersOf(data) : null;
  const scores = mods && sent.scoreChanges ? scoresOf(base, data, mods, warnings) : null;
  const scoreMods = scores ? (Object.fromEntries(ABILITY_KEYS.map((a) => [a, abilityMod(scores[a])])) as Record<AbilityKey, number>) : null;
  // The level is null exactly when the classes were not read, so each output that needs the classes tests it.
  const level = sent.classes ? levelOf(classes, warnings) : null;
  const hasFeature = (feature: string) => classes.find((c) => c.features.has(feature.toLowerCase()));

  const stats: PcFillStats = { rolls: [] };
  if (scores) stats.abilities = scores;
  if (mods) {
    stats.saves = savesOf(mods);
    stats.skills = skillsOf(mods);
    stats.defenses = defensesOf(mods);
    stats.jack = has(mods, "half-proficiency", "ability-checks");
    stats.alert = has(mods, "proficiency", "initiative");
  }
  if (mods && scoreMods) stats.adjust = adjustOf(mods, scoreMods);
  const spellAbility = classes.find((c) => c.spellAbility !== null)?.spellAbility ?? null;
  if (level !== null) {
    stats.spellAbility = spellAbility;
    stats.evasion = hasFeature("Evasion") !== undefined;
    stats.critOn = hasFeature("Superior Critical") ? 18 : hasFeature("Improved Critical") ? 19 : null;
  }

  const ctx: Ctx = { warnings, newId };
  const rogue = hasFeature("Sneak Attack");
  const weapons = sent.inventory && level !== null && scores ? weaponRolls(data, ctx, scores, rogue ? `${Math.ceil(rogue.level / 2)}d6` : null) : null;
  const spells = sent.spellLists && level !== null ? spellRolls(data, ctx, level, spellAbility) : null;
  const actions = sent.actions ? actionRolls(data, ctx) : null;
  const cut = cutRolls(weapons, spells?.rolls ?? null, actions);
  stats.rolls = cut.rolls;
  if (spells && !spells.whole) {
    cut.read.spell = false;
    warnings.splice(resourceLinesAt, 0, "Some of D&D Beyond's spells were not read, since a list of them was too long or did not read. Spells here that they would change stay as they are.");
  }
  if (weapons && !wholeList(data.inventory, MAX.inventory)) {
    cut.read.weapon = false;
    warnings.splice(resourceLinesAt, 0, "Some of D&D Beyond's equipment was not read, since the list was too long. Weapons here that it would change stay as they are.");
  }
  if (sent.actions && !actionsWhole(data)) {
    cut.read.other = false;
    warnings.splice(resourceLinesAt, 0, "Some of D&D Beyond's actions were not read, since a list of them was too long or did not read. Rolls and class resources here that they would change stay as they are.");
  }
  if (spells && spells.unhalved.length > 0) {
    // Up to 8 names, fewer when long ones would pass a warning's 400 characters, which would refuse the whole fill.
    const unhalved = (n: number) =>
      `Whether a pass halves the damage is not known for ${spells.unhalved.slice(0, n).join(", ")}${spells.unhalved.length > n ? " and others" : ""}. A cantrip's pass takes none and another spell's half until you set On a pass.`;
    let shown = Math.min(8, spells.unhalved.length);
    while (shown > 1 && unhalved(shown).length > 400) shown--;
    warnings.push(unhalved(shown));
  }
  if (cut.over > 0) warnings.push(cutWarning(cut.over, cname ?? "the character"));

  const actor: PcFill["actor"] = {};
  if (mods && scoreMods && sent.inventory) actor.ac = acOf(data, mods, scoreMods.dex);
  const override = num(data.overrideHitPoints);
  const baseHp = num(data.baseHitPoints);
  // An override is the whole maximum. Otherwise it reads the Constitution modifier and every per-level bonus once per level.
  if (override !== null && override >= 1) actor.hpMax = Math.min(100_000, Math.round(override));
  else if (mods && scoreMods && level !== null && baseHp !== null) {
    const hp = baseHp + (num(data.bonusHitPoints) ?? 0) + (scoreMods.con + sumOf(mods, "bonus", "hit-points-per-level", scoreMods)) * level;
    if (hp >= 1) actor.hpMax = Math.min(100_000, Math.round(hp));
  }
  const speeds = speedsOf(data);
  if (speeds) actor.speeds = speeds;
  if (mods) {
    const darkvision = Math.max(0, ...mods.filter((m) => m.type === "set-base" && m.subType === "darkvision" && m.value !== null).map((m) => m.value!));
    // Darkvision is the one sense read, so without it the card keeps whatever senses it has, never set to none by an import.
    if (darkvision > 0) actor.senses = `Darkvision ${Math.min(1000, Math.round(darkvision))} ft.`;
  }
  const id = num(data.id);
  if (id !== null && Number.isInteger(id) && id > 0 && id < 1e12) actor.sheetUrl = ddbSheetUrl(String(id));

  const resources = sent.actions ? readResources(data, { scoreMods, level, who: cname ?? "the character" }) : null;
  if (resources) warnings.splice(resourceLinesAt, 0, ...resources.warnings);

  const fill: PcFill = { source: "ddb", stats, actor, warnings: warnings.slice(0, 40), read: { ...cut.read, resource: resources?.whole ?? false } };
  if (resources) fill.resources = resources.resources;
  if (level !== null) fill.level = level;
  if (cname) fill.name = cname;
  return fill;
}
