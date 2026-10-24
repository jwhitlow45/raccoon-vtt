import { ABILITY_KEYS, CONDITION_KEYS, type AbilityKey, type ConditionKey } from "../model.ts";
import { DAMAGE_TYPES, type DamageType } from "../rules/damage.ts";
import type { StatBlockMonster } from "../srd/monsters.ts";
import type { DamagePart, NamedRoll } from "./bonus.ts";
import { formatFormula, parseFormula } from "./formula.ts";

/**
 * The rolls a stat block names (docs/design-v1-roll-options.md 3.1): its
 * attacks, save actions, damage, healing and recharge, read from the
 * block's Markdown as doc 1's NamedRoll. Every SRD block, every room
 * monster and every companion block has that Markdown (shared/srd/monsters.ts,
 * shared/statBlock.ts statBlockMarkdown), and room monsters and pasted text
 * keep 2014 wording as typed, so each rule reads both editions.
 *
 * Only a section's bold run-in paragraphs are read. The SRD's later
 * paragraphs of an entry hold the monster's own saves, such as a behir
 * keeping what it swallowed, which are not rolls the entry makes.
 */

export type SectionKey = Exclude<NamedRoll["section"], "spells">;

/** One entry of a block: its bold name and the paragraph it runs into, unescaped. */
export type BlockEntry = { section: SectionKey; name: string; text: string };

const SECTION_BY_TITLE: Record<string, SectionKey> = {
  Traits: "traits",
  Actions: "actions",
  "Bonus Actions": "bonusActions",
  Reactions: "reactions",
  "Legendary Actions": "legendaryActions",
};

function unescapeMd(text: string): string {
  return text.replace(/\\([*_`\\])/g, "$1");
}

const entriesRead = new WeakMap<StatBlockMonster, readonly BlockEntry[]>();

/** The block's entries in their order, read once per view object. */
export function blockEntries(view: StatBlockMonster): readonly BlockEntry[] {
  const cached = entriesRead.get(view);
  if (cached) return cached;
  const out: BlockEntry[] = [];
  let section: SectionKey | null = null;
  for (const block of view.statBlock.split("\n\n")) {
    if (block.startsWith("### ")) {
      section = SECTION_BY_TITLE[block.slice(4).trim()] ?? null;
      continue;
    }
    if (!section) continue;
    const named = /^\*\*(.+?)\.\*\*(?: (.*))?$/s.exec(block);
    if (named) out.push({ section, name: unescapeMd(named[1]!).trim(), text: unescapeMd(named[2] ?? "").trim() });
  }
  entriesRead.set(view, out);
  return out;
}

/** Whether the block has a trait of this name, "Magic Resistance" or "Evasion", in any letter case, with or without a bracket after it. */
export function hasTrait(view: StatBlockMonster, name: string): boolean {
  const wanted = name.toLowerCase();
  return blockEntries(view).some((e) => e.section === "traits" && (e.name.toLowerCase() === wanted || e.name.toLowerCase().startsWith(`${wanted} (`)));
}

/** The Multiattack paragraph, a note the options list heads the actions with ("makes three Rend attacks"), or null. */
export function multiattackNote(view: StatBlockMonster): string | null {
  return blockEntries(view).find((e) => e.section === "actions" && /^multiattack\b/i.test(e.name))?.text ?? null;
}

const ABILITY_BY_NAME: Record<string, AbilityKey> = {
  strength: "str",
  dexterity: "dex",
  constitution: "con",
  intelligence: "int",
  wisdom: "wis",
  charisma: "cha",
};
const ABILITY_WORDS = "Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma";
const MINUS = /[−–]/g;

/** "+4" from either sign the SRD prints, and its minus, as a number. */
function signedValue(sign: string, digits: string): number {
  return (sign === "+" ? 1 : -1) * Number(digits);
}

/*
 * 2024 prints "Melee Attack Roll: +4" (once with "to hit" after it), 2014
 * "Melee Weapon Attack: +4 to hit" and "Ranged Spell Attack: +5 to hit",
 * with every mix of melee or ranged and weapon or spell.
 */
const ATTACK = /\b(?:Melee|Ranged)(?: or (?:Melee|Ranged))?(?: (?:Weapon|Spell)(?: or (?:Weapon|Spell))?)? Attack(?: Roll)?:\s*([+\-−–])\s*(\d+)/i;
const SAVE_2024 = new RegExp(`\\b(${ABILITY_WORDS}) Saving Throw:\\s*DC\\s*(\\d+)`, "i");
const SAVE_2014 = new RegExp(`\\bDC\\s*(\\d+) (${ABILITY_WORDS}) saving throw\\b`, "i");

/**
 * A clause's label, at the start of the text or of a sentence: "Hit:",
 * "Failure:", "Dexterity Saving Throw:", "Trigger:". Any such label ends
 * the clause before it, so "Failure or Success" never runs into "Success".
 */
const LABEL = /(?:^|(?<=[.!?]\s))([A-Z][A-Za-z0-9]*(?: [A-Za-z0-9]+){0,5}):\s/g;

type Clause = { label: string; body: string };

function clausesOf(text: string): Clause[] {
  const marks = [...text.matchAll(LABEL)];
  return marks.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1]!.index : text.length;
    return { label: m[1]!, body: text.slice(start, end).trim() };
  });
}

function clause(clauses: readonly Clause[], label: string): string | null {
  return clauses.find((c) => c.label.toLowerCase() === label.toLowerCase())?.body ?? null;
}

/** A clause's sentences. A sentence starts after ". " and a capital, so "5 ft. of" stays whole. */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((s) => s !== "");
}

/** "5 (1d6 + 2) Slashing damage". Pasted text may leave out the average. */
const DAMAGE = /(?:\d+\s*)?\(\s*(\d+\s*d\s*\d+(?:\s*[+\-−–]\s*\d+)?)\s*\)\s+([A-Za-z]+)\s+damage\b/g;
const TIMED = /\bat the (?:start|end) of each of (?:its|their|the [^.,;]+?[’']s) turns\b/i;
const OPTIONAL = /^\s*((?:if|when|while)\b[^.,;]*)/i;
const DAMAGE_WORDS = new Set<string>(DAMAGE_TYPES);

function canonical(dice: string): string | null {
  const parsed = parseFormula(dice.replace(MINUS, "-").replace(/\s+/g, ""));
  return parsed.ok ? formatFormula(parsed.formula) : null;
}

type Read = { now: DamagePart[]; later: DamagePart[] };

/**
 * A clause's damage as typed parts. The first sentence is always taken now,
 * whatever else it says. A later sentence's damage is taken later only when
 * that sentence says when ("takes 10 (3d6) Acid damage at the start of each
 * of the cube's turns"), so "until" and "for 1 minute", which bound a
 * condition, never move a damage. A part on "if", "when" or "while" is
 * optional. A part after "or" replaces the one before it on a condition,
 * which a part cannot say, so it is left out, as is one whose formula
 * parseFormula refuses.
 */
function readDamage(text: string): Read {
  const out: Read = { now: [], later: [] };
  sentencesOf(text).forEach((sentence, i) => {
    const later = i > 0 && TIMED.test(sentence);
    let from = 0;
    for (const m of sentence.matchAll(DAMAGE)) {
      const before = sentence.slice(from, m.index);
      from = m.index + m[0].length;
      if (/\bor\s*$/i.test(before)) continue;
      const formula = canonical(m[1]!);
      if (formula === null) continue;
      const part: DamagePart = { formula };
      const word = m[2]!.toLowerCase();
      if (DAMAGE_WORDS.has(word)) part.type = word as DamageType;
      const optional = OPTIONAL.exec(sentence.slice(from));
      if (optional) {
        part.optional = true;
        part.name = optional[1]!.trim();
      }
      (later ? out.later : out.now).push(part);
    }
  });
  return out;
}

const CONDITION_WORDS = new Set<string>(CONDITION_KEYS);
const HAS_CONDITIONS = /\bhas the ([A-Z][a-z]+(?:(?:,\s*(?:and\s+)?|\s+and\s+|\s+or\s+)[A-Z][a-z]+)*) conditions?\b/g;
/** 2014's "or be poisoned", "is paralyzed", "or be knocked prone". */
const IS_CONDITION = /\b(?:or be(?:come)?|is|becomes?)\s+(?:knocked\s+)?([a-z]+)\b/gi;

/** 2024 names a condition "has the Restrained condition". 2014's words are read only in 2014 text, where "is" can name one. */
function conditionsIn(text: string, old: boolean): ConditionKey[] {
  const out: ConditionKey[] = [];
  const add = (word: string) => {
    const key = word.toLowerCase();
    if (CONDITION_WORDS.has(key) && !out.includes(key as ConditionKey)) out.push(key as ConditionKey);
  };
  for (const m of text.matchAll(HAS_CONDITIONS)) for (const word of m[1]!.split(/,|\band\b|\bor\b/)) add(word.trim());
  if (old) for (const m of text.matchAll(IS_CONDITION)) add(m[1]!);
  return out;
}

const SAVE_ENDS = /\brepeats? the (?:save|saving throw) at the end of each of its turns\b/i;
const LASTS = /\buntil the (start|end) of (its|the [^.,;]+?[’']s) next turn\b/i;

function lastsIn(text: string): NamedRoll["lasts"] | undefined {
  const m = LASTS.exec(text);
  if (!m) return undefined;
  // "its next turn" and "the target's next turn" are the target's. A turn named for anyone else is the acting creature's.
  const whose = m[2]!.toLowerCase();
  return { at: m[1]!.toLowerCase() as "start" | "end", of: whose === "its" || /^the target[’']s$/.test(whose) ? "target" : "self" };
}

/**
 * What a failed save or a hit gives besides damage: its conditions and how
 * they end. `repeats` is where a save that ends them may be named, which in
 * 2014 text is a later sentence ("The creature can repeat the saving throw
 * at the end of each of its turns").
 */
function effectsOf(text: string, old: boolean, repeats = text): Pick<NamedRoll, "conditions" | "saveEnds" | "lasts"> {
  const out: Pick<NamedRoll, "conditions" | "saveEnds" | "lasts"> = {};
  const conditions = conditionsIn(text, old);
  if (conditions.length > 0) out.conditions = conditions;
  if (SAVE_ENDS.test(repeats)) out.saveEnds = true;
  const lasts = lastsIn(text);
  if (lasts) out.lasts = lasts;
  return out;
}

const HEAL = /\bregains?\s+\d+\s*\(\s*(\d+\s*d\s*\d+(?:\s*[+\-−–]\s*\d+)?)\s*\)\s*hit points\b/i;
const RECHARGE = /^recharge\s+(\d)(?:\s*[–\-−]\s*6)?$/i;
const USES = /^(\d+)\/day\b/i;
const RECHARGE_IN_NAME = /\(recharge\s+[2-6]\b/i;
/** "(Recharge after a Short or Long Rest)", 2014's "(Recharges after a Short or Long Rest)" too. */
const REST_RECHARGE = /^recharges? after a short or long rest$/i;
/** An older block's "(Costs 2 Actions)" on a legendary action. */
const COST = /^costs\s+([1-3])\s+actions?$/i;

/**
 * A printed name's parts (docs/design-v1-combat-controls.md 2.1): the name
 * without its recharge, uses, rest recharge or cost bracket, which the
 * options and the combat uses show on their own. `shown` keeps the rest
 * recharge and the cost, as the Dice panel's rows have always named them.
 * `perDay` is the N of "(N/Day", and `uses` the bracket's words.
 */
export type NameParts = { name: string; shown: string; recharge?: NamedRoll["recharge"]; uses?: string; perDay?: number; rest?: true; cost?: number };

export function nameParts(printed: string): NameParts {
  const out: NameParts = { name: printed, shown: printed };
  let shown = printed;
  out.name = printed
    .replace(/\s*\(([^()]*)\)/g, (whole, inner: string) => {
      const words = inner.trim();
      const recharge = RECHARGE.exec(words);
      const n = recharge ? Number(recharge[1]) : 0;
      if (n >= 2 && n <= 6) {
        out.recharge = n as NamedRoll["recharge"];
        shown = shown.replace(whole, "");
        return "";
      }
      const perDay = USES.exec(words);
      if (perDay) {
        out.uses = words;
        out.perDay = Number(perDay[1]);
        shown = shown.replace(whole, "");
        return "";
      }
      if (REST_RECHARGE.test(words)) {
        out.rest = true;
        return "";
      }
      const cost = COST.exec(words);
      if (cost) {
        out.cost = Number(cost[1]);
        return "";
      }
      return whole;
    })
    .trim();
  out.shown = shown.trim();
  return out;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "roll"
  );
}

/**
 * The longest slug a key keeps whole, and how much of a longer one it keeps
 * before its hash: the longest section, its colon, 44 and a repeat's "-99"
 * make 64. The SRD's longest is 42, the wererat's "Hand Crossbow (Humanoid
 * or Hybrid Form Only)", so no SRD key is cut.
 */
const SLUG_MAX = 44;
const SLUG_CUT = 37;

/** 6 hex digits of FNV-1a over the name's UTF-16 units: the same on every device, with no crypto to load. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

/** A name's slug, cut to 37 characters and 6 hex digits of the whole name's hash where it runs past 44, so a key stays within 64. */
function keySlug(name: string): string {
  const whole = slug(name);
  if (whole.length <= SLUG_MAX) return whole;
  return `${whole.slice(0, SLUG_CUT).replace(/-+$/, "")}-${shortHash(name)}`;
}

const keysRead = new WeakMap<StatBlockMonster, readonly string[]>();

/**
 * Every entry's key, in blockEntries' order (docs/design-v1-combat-controls.md
 * 2.1): its section, a colon and a slug of its name without its brackets,
 * then `-2` and up for a name repeated in its section. Each entry has one
 * before any is read into rolls, so a roll's key (its entry's, with `:hit`
 * or `:later` for a follow-up) and a spent ability's key name the same
 * entry on every device, whatever rolls an entry makes. At most 64
 * characters, as the use key's contract bounds it (shared/protocol.ts).
 */
export function entryKeys(view: StatBlockMonster): readonly string[] {
  const cached = keysRead.get(view);
  if (cached) return cached;
  const taken = new Set<string>();
  const out = blockEntries(view).map((entry) => {
    const base = `${entry.section}:${keySlug(nameParts(entry.name).name)}`;
    let key = base;
    for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
    taken.add(key);
    return key;
  });
  keysRead.set(view, out);
  return out;
}

type Save = { ability: AbilityKey; dc: number; at: number; edition: 2014 | 2024 };

function saveIn(text: string): Save | null {
  const now = SAVE_2024.exec(text);
  const then = SAVE_2014.exec(text);
  const pick = now && (!then || now.index <= then.index) ? now : then;
  if (!pick) return null;
  const is2024 = pick === now;
  const ability = ABILITY_BY_NAME[(is2024 ? pick[1]! : pick[2]!).toLowerCase()];
  const dc = Number(is2024 ? pick[2] : pick[1]);
  return ability && ABILITY_KEYS.includes(ability) ? { ability, dc, at: pick.index, edition: is2024 ? 2024 : 2014 } : null;
}

/**
 * A 2014 save's own words: from the save on, its sentence and every later
 * one ("Each creature ... must make a DC 13 Dexterity saving throw,
 * taking 22 (5d8) fire damage on a failed save, or half as much damage on
 * a successful one."), and the sentences that name what the failure gives,
 * the save's own and those that begin "On a failed save".
 */
function save2014(text: string, at: number): { damage: string; effects: string } {
  const from = text.slice(at);
  const sentences = sentencesOf(from);
  const effects = sentences.filter((s, i) => i === 0 || /^on a failed save\b/i.test(s)).join(" ");
  return { damage: from, effects };
}

type Roll = Omit<NamedRoll, "key" | "name" | "section">;

/** The rolls one paragraph makes: none, one, or with a follow-up save after a hit and damage on later turns, up to three. */
function entryRolls(entry: BlockEntry): { suffix: string; label: string; roll: Roll }[] {
  if (/^multiattack\b/i.test(entry.name) || /^spellcasting\b/i.test(entry.name)) return [];
  const text = entry.text;
  const clauses = clausesOf(text);
  const attack = ATTACK.exec(text);
  const save = saveIn(text);
  const heal = HEAL.exec(text);
  const old = (attack !== null && !/attack roll/i.test(attack[0])) || save?.edition === 2014;
  const later: DamagePart[] = [];
  const out: { suffix: string; label: string; roll: Roll }[] = [];

  // The hit: 2024's "Hit:" and "Hit or Miss:", each read as a hit, or 2014's "Hit:" up to the save it may go on with.
  const hitClauses = [clause(clauses, "Hit"), clause(clauses, "Hit or Miss")].filter((c): c is string => c !== null);
  if (save?.edition === 2014 && hitClauses[0] !== undefined) {
    const cut = hitClauses[0].search(SAVE_2014);
    if (cut >= 0) hitClauses[0] = hitClauses[0].slice(0, cut);
  }

  // The failure: 2024's "Failure:", or its "First Failure:" where the action has one, or 2014's own words.
  let failDamage = "";
  let failEffects = "";
  let onPass: "half" | "none" = "none";
  if (save?.edition === 2024) {
    failDamage = failEffects = clause(clauses, "Failure") ?? clause(clauses, "First Failure") ?? "";
    if (/^half damage\b/i.test(clause(clauses, "Success") ?? "")) onPass = "half";
  } else if (save) {
    const words = save2014(text, save.at);
    failDamage = words.damage;
    failEffects = words.effects;
    if (/\bhalf as much damage on a successful (?:one|save)\b/i.test(words.damage)) onPass = "half";
  }

  if (attack) {
    const damage: DamagePart[] = [];
    for (const text of hitClauses) {
      const hit = readDamage(text);
      damage.push(...hit.now);
      later.push(...hit.later);
    }
    const roll: Roll = { attack: signedValue(attack[1]!.replace(MINUS, "-"), attack[2]!), damage, ...effectsOf(hitClauses.join(" "), old) };
    out.push({ suffix: "", label: "", roll });
  }
  if (save) {
    const fail = readDamage(failDamage);
    later.push(...fail.later);
    const roll: Roll = { save: { ability: save.ability, dc: save.dc, onPass }, damage: fail.now, ...effectsOf(failEffects, old, failDamage) };
    // After an attack, the save is what a hit goes on to, so it is its own roll and its damage never joins the hit's.
    out.push(attack ? { suffix: ":hit", label: ", on a hit", roll } : { suffix: "", label: "", roll });
  }
  if (heal) {
    const formula = canonical(heal[1]!);
    if (formula !== null) {
      if (out[0]) out[0].roll.heal = { formula };
      else out.push({ suffix: "", label: "", roll: { damage: [], heal: { formula } } });
    }
  }
  if (later.length > 0) out.push({ suffix: ":later", label: ", later turns", roll: { damage: later } });
  // A recharge is a roll of its own, so an action that only teleports still gets its 1d6 and its Used.
  if (out.length === 0 && RECHARGE_IN_NAME.test(entry.name)) out.push({ suffix: "", label: "", roll: { damage: [] } });
  return out;
}

const read = new WeakMap<StatBlockMonster, NamedRoll[]>();

/**
 * Every named roll of a block, in the block's order, read once per view
 * object. Doc 2's paste reader calls it too, on a pasted block's view.
 */
export function blockActions(view: StatBlockMonster): NamedRoll[] {
  const cached = read.get(view);
  if (cached) return cached;
  const out: NamedRoll[] = [];
  const keys = entryKeys(view);
  blockEntries(view).forEach((entry, i) => {
    const { shown, recharge, uses } = nameParts(entry.name);
    for (const { suffix, label, roll } of entryRolls(entry)) {
      const named: NamedRoll = { key: `${keys[i]!}${suffix}`, name: `${shown}${label}`, section: entry.section, ...roll };
      // A recharge or uses limit belongs to the action, so its later damage and follow-up save carry none of their own.
      if (suffix === "") {
        if (recharge !== undefined) named.recharge = recharge;
        if (uses !== undefined) named.uses = uses;
      }
      out.push(named);
    }
  });
  read.set(view, out);
  return out;
}
