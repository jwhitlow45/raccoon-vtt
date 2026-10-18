import { ABILITY_KEYS, CR_VALUES, type AbilityKey, type MonsterSize, type StatBlock, type StatBlockEntry } from "#shared/model.ts";
import { MAX_STAT_BLOCK_ENTRIES } from "#shared/protocol.ts";
import { abilityMod, emptyStatBlock, hpAverage, parseSigned, SECTIONS, XP_BY_CR, type SectionKey } from "#shared/statBlock.ts";

/**
 * Reads a stat block pasted as plain text into the editor's fields (features
 * section 15), in the browser, for the DM to check and fix before saving.
 *
 * Text copied from a web page and text copied from a PDF differ in the ways
 * that matter here. A web page gives one line per paragraph and the ability
 * table as tab-separated cells, or one cell per line on some phones. A PDF
 * wraps every paragraph at the column's width and runs the ability table
 * across two lines. So lines are classified by what they start with, never
 * by where they sit, and wrapped paragraphs are joined back together when
 * most lines end mid-sentence.
 *
 * The 2024 layout comes first. The 2014 one ("Armor Class", "Hit Points",
 * "Challenge", an ability row under a header row, traits without a heading)
 * reads into the same fields, with initiative taken from Dexterity.
 *
 * It never throws and never refuses: whatever it cannot find keeps the blank
 * stat block's value and adds a warning, so the DM knows what to check.
 */

export type ParsedStatBlock = { block: StatBlock; warnings: string[] };

type Line = { text: string; blankBefore: boolean };

const SIZE_WORDS = "Tiny|Small|Medium|Large|Huge|Gargantuan";
const SIZE_LINE = new RegExp(`^(${SIZE_WORDS})(?: or (${SIZE_WORDS}))? (.+), ([^,]+)$`, "i");

const SECTION_HEADINGS: Record<string, SectionKey | null> = {
  traits: "traits",
  actions: "actions",
  "bonus actions": "bonusActions",
  reactions: "reactions",
  "legendary actions": "legendaryActions",
  // Older blocks print these. Their paragraphs stay text in the section before them.
  "lair actions": null,
  "regional effects": null,
  "mythic actions": null,
};

type Field =
  | "ac"
  | "initiative"
  | "hp"
  | "speed"
  | "saves"
  | "skills"
  | "vulnerabilities"
  | "resistances"
  | "immunities"
  | "conditionImmunities"
  | "gear"
  | "senses"
  | "languages"
  | "cr"
  | "ignored";

/** The labeled lines of both layouts. "Condition Immunities" comes before "Immunities", which would take it too. */
const LABELS: { re: RegExp; field: Field }[] = [
  { re: /^armor class\b/i, field: "ac" },
  { re: /^ac\b/i, field: "ac" },
  { re: /^initiative\b/i, field: "initiative" },
  { re: /^hit points\b/i, field: "hp" },
  { re: /^hp\b/i, field: "hp" },
  { re: /^speed\b/i, field: "speed" },
  { re: /^saving throws\b/i, field: "saves" },
  { re: /^skills\b/i, field: "skills" },
  { re: /^(?:damage )?vulnerabilities\b/i, field: "vulnerabilities" },
  { re: /^(?:damage )?resistances\b/i, field: "resistances" },
  { re: /^condition immunities\b/i, field: "conditionImmunities" },
  { re: /^(?:damage )?immunities\b/i, field: "immunities" },
  { re: /^gear\b/i, field: "gear" },
  { re: /^senses\b/i, field: "senses" },
  { re: /^languages\b/i, field: "languages" },
  { re: /^challenge\b/i, field: "cr" },
  { re: /^cr\b/i, field: "cr" },
  { re: /^proficiency bonus\b/i, field: "ignored" },
];

/** Fields printed below the ability table. Once one shows up, the table is over. */
const AFTER_TABLE = new Set<Field>(["saves", "skills", "vulnerabilities", "resistances", "immunities", "conditionImmunities", "gear", "senses", "languages", "cr"]);

const ABILITY_WORD = /\b(?:STR|DEX|CON|INT|WIS|CHA|MOD|SAVE)\b/i;
const MINUS = "[+\u2212\u2013-]";
const SPELL_ITEM = /^(at will|\d+\/day(?: each)?):\s*(.*)$/i;
/** 2014 spell slots: "Cantrips (at will): ..." and "1st level (4 slots): ...". */
const SLOT_ITEM = /^(?:cantrips \(at will\)|\d+(?:st|nd|rd|th) level \([^)]*\)):/i;
const BULLET = /^[\u2022\u00b7\u25aa\u25cf\u25e6]\s*(.*)$/;
const TOO_MANY = `Only the first ${MAX_STAT_BLOCK_ENTRIES} entries of a section were kept.`;
const SMALL_WORDS = new Set(["of", "the", "and", "or", "to", "in", "a", "an", "from", "with", "on", "at", "for", "by", "only"]);

/**
 * Spaces of every width become one, and invisible characters go: zero-width
 * joiners and the direction marks a web page may carry, which a name refuses.
 */
function cleanLine(raw: string): string {
  return raw
    .replace(/[\t\u00a0\u2007\u2009\u202f ]+/g, " ")
    .replace(/[\p{Cc}\u200b-\u200f\u202a-\u202e\u2066-\u2069\u061c\ufeff]/gu, "")
    .trim();
}

function linesOf(text: string): Line[] {
  const out: Line[] = [];
  let blank = false;
  for (const raw of text.replace(/\r\n?|[\u2028\u2029]/g, "\n").split("\n")) {
    const line = cleanLine(raw);
    if (!line) {
      blank = true;
      continue;
    }
    out.push({ text: line, blankBefore: blank && out.length > 0 });
    blank = false;
  }
  return out;
}

/**
 * The bold name that opens an entry ("Fire Breath (Recharge 5–6). Dexterity
 * Saving Throw: ..."), or null. A name is a few title-case words with an
 * optional parenthetical, as scripts/srd-import.ts reads them, so a
 * sentence that merely holds a full stop is not mistaken for one.
 */
function runIn(text: string): { name: string; rest: string } | null {
  const m = text.match(/^([A-Z0-9][^.]*?)\.(?:\s+(.*))?$/s);
  if (!m) return null;
  const name = m[1]!;
  if (name.length > 70) return null;
  // The openers of a 2024 effect, which a PDF can wrap to the start of a line, are never names.
  if (/\b(?:Saving Throw|Attack Roll)\b|\bDC \d/.test(name)) return null;
  const words = name
    .replace(/\([^)]*\)/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 7) return null;
  // A real word or a row of a dice table ("1-4."), so a wrapped "DC 12. Failure: ..." is not taken for a name.
  if (!words.some((w) => /^[A-Z][a-z]/.test(w)) && !/^\d+(?:[\u2013-]\d+)?$/.test(name)) return null;
  return words.every((w) => /^[A-Z0-9\u2019'"\u201c]/.test(w) || SMALL_WORDS.has(w)) ? { name, rest: m[2] ?? "" } : null;
}

/** Labels start with a capital, so a wrapped line that begins "languages but can't speak" stays a continuation. */
function labelOf(text: string): { field: Field; value: string } | null {
  if (!/^[A-Z]/.test(text)) return null;
  for (const { re, field } of LABELS) {
    const m = text.match(re);
    if (m) return { field, value: text.slice(m[0].length).replace(/^\s*:?\s*/, "") };
  }
  return null;
}

function sectionOf(text: string): SectionKey | null | undefined {
  const key = text.replace(/:$/, "").trim().toLowerCase();
  return key in SECTION_HEADINGS ? SECTION_HEADINGS[key] : undefined;
}

/** Part of the ability table: an ability's name, the column headings, or only numbers. Never a speed. */
function isAbilityLine(text: string): boolean {
  if (/\bft\b/i.test(text)) return false;
  return ABILITY_WORD.test(text) || new RegExp(`^(?:${MINUS}?\\s?\\d+\\s*|\\(\\s*${MINUS}?\\s?\\d+\\s*\\)\\s*)+$`).test(text);
}

/** A full stop, a question, an exclamation or a colon, perhaps inside closing quotes or brackets. A bare ")" is often a line broken mid-sentence. */
function endsSentence(text: string): boolean {
  return /[.!?:]["\u201d\u2019)\]]*$/.test(text);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * "bludgeoning, lightning" to "Bludgeoning, Lightning": each item of a list
 * starts with a capital, as the 2024 block prints damage types and
 * conditions, but a clause such as "and slashing from nonmagical attacks"
 * keeps its small first word.
 */
function capitalizeItems(text: string): string {
  return text.replace(/(^|[,;]\s*)([a-z]+)/g, (all, sep: string, word: string) => (SMALL_WORDS.has(word) ? all : `${sep}${capitalize(word)}`));
}

/** Some books print the name in capitals ("ADULT RED DRAGON"). The block's name is in title case. */
function nameCase(name: string): string {
  return /[a-z]/.test(name) || !/[A-Z]{2}/.test(name) ? name : titleCase(name.toLowerCase());
}

/** "lawful evil" to "Lawful Evil", for 2014 blocks that print it in lower case. */
function titleCase(s: string): string {
  return s.replace(/[A-Za-z][^\s(]*/g, (w, at: number) => (at > 0 && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : capitalize(w)));
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** "20d10+40" or "1d4 − 1" to "20d10 + 40" and "1d4 - 1", the stored form. */
function normalizeFormula(text: string): string {
  const m = text.trim().match(new RegExp(`^(\\d+)\\s*d\\s*(\\d+)(?:\\s*(${MINUS})\\s*(\\d+))?$`, "i"));
  if (!m) return text.trim().replace(/[\u2212\u2013]/g, "-");
  return m[3] ? `${m[1]}d${m[2]} ${m[3] === "+" ? "+" : "-"} ${m[4]}` : `${m[1]}d${m[2]}`;
}

/** Abilities from the table's text, in either layout. Missing ones stay out. */
function readAbilities(text: string): Partial<Record<AbilityKey, { score: number; save?: number }>> {
  const out: Partial<Record<AbilityKey, { score: number; save?: number }>> = {};
  const header = text.match(/\bSTR\s+DEX\s+CON\s+INT\s+WIS\s+CHA\b/i);
  if (header) {
    // 2014: a row of names, then a row of "21 (+5)" in the same order.
    const after = text.slice((header.index ?? 0) + header[0].length);
    const scores = [...after.matchAll(new RegExp(`(\\d{1,2})\\s*\\(\\s*${MINUS}?\\s?\\d+\\s*\\)`, "g"))];
    ABILITY_KEYS.forEach((key, i) => {
      const m = scores[i];
      if (m) out[key] = { score: Number(m[1]) };
    });
    return out;
  }
  const row = new RegExp(`\\b(STR|DEX|CON|INT|WIS|CHA)\\b\\s*(\\d{1,2})(?:\\s*\\(\\s*${MINUS}?\\s?\\d+\\s*\\)|\\s+${MINUS}\\s?\\d+)?(?:\\s+(${MINUS})\\s?(\\d+))?`, "gi");
  for (const m of text.matchAll(row)) {
    const key = m[1]!.toLowerCase() as AbilityKey;
    if (out[key]) continue;
    out[key] = { score: Number(m[2]), ...(m[3] ? { save: parseSigned(`${m[3]}${m[4]}`) } : {}) };
  }
  return out;
}

/** "Dex +3, Con +6" from a 2014 Saving Throws line. */
function readSaves(text: string): Partial<Record<AbilityKey, number>> {
  const out: Partial<Record<AbilityKey, number>> = {};
  for (const m of text.matchAll(new RegExp(`\\b(Str|Dex|Con|Int|Wis|Cha)[a-z]*\\s*(${MINUS}\\s?\\d+)`, "gi"))) {
    out[m[1]!.toLowerCase() as AbilityKey] = parseSigned(m[2]!.replace(/\s/g, ""));
  }
  return out;
}

/** A 2014 movement line uses lower case ("swim 40 ft."). The 2024 block capitalizes each kind. */
function normalizeSpeed(text: string): string {
  const kind = (w: string) => capitalize(w.toLowerCase());
  return text.replace(/(^|,\s*)(burrow|climb|fly|swim)(?: or (burrow|climb|fly|swim))?\b/gi, (_, sep: string, a: string, b?: string) => `${sep}${kind(a)}${b ? ` or ${kind(b)}` : ""}`);
}

/** Each sense starts with a capital, as the 2024 block prints them. */
function normalizeSenses(text: string): string {
  return text
    .split(/,\s*(?![^()]*\))/)
    .map((s) => capitalize(s.trim()))
    .filter(Boolean)
    .join(", ");
}

function truncate(text: string, max: number, what: string, warnings: string[]): string {
  if (text.length <= max) return text;
  warnings.push(`${what} was cut to ${max} characters.`);
  return text.slice(0, max);
}

/** Two warnings about what only a monster's block holds, which a character's fill leaves out (pcstats/fromBlock.ts). */
export const NO_SIZE_LINE = "No size, type and alignment line was found.";
export const NO_CHALLENGE_RATING = "No challenge rating was found.";

export function parseStatBlockText(input: string): ParsedStatBlock {
  const warnings: string[] = [];
  const block = emptyStatBlock();
  const lines = linesOf(input);
  if (lines.length === 0) return { block, warnings: ["There is nothing to read."] };

  // The name sits right above the size line, so stray lines copied before it are skipped.
  let at = lines.slice(0, 8).findIndex((l) => SIZE_LINE.test(l.text));
  if (at >= 0) {
    const m = lines[at]!.text.match(SIZE_LINE)!;
    block.size = m[1]!.toLowerCase() as MonsterSize;
    if (m[2]) block.sizeAlt = m[2].toLowerCase() as MonsterSize;
    block.type = truncate(capitalize(m[3]!), 120, "The type", warnings);
    block.alignment = truncate(titleCase(m[4]!), 120, "The alignment", warnings);
    if (at > 0) block.name = truncate(nameCase(lines[at - 1]!.text), 80, "The name", warnings);
    else warnings.push("No name was found above the size line.");
    at++;
  } else {
    warnings.push(NO_SIZE_LINE);
    block.name = truncate(nameCase(lines[0]!.text), 80, "The name", warnings);
    at = 1;
  }

  // The header: labeled lines, the ability table, and the lines that wrap them.
  const values = new Map<Field, string>();
  const tableText: string[] = [];
  let current: Field | null = null;
  let tableOver = false;
  for (; at < lines.length; at++) {
    const text = lines[at]!.text;
    if (sectionOf(text) !== undefined) break;
    const label = labelOf(text);
    if (label) {
      current = label.field;
      if (AFTER_TABLE.has(label.field)) tableOver = true;
      values.set(label.field, label.value);
      continue;
    }
    // Older blocks print traits right after the challenge rating, with no heading.
    if (values.has("cr") && runIn(text)) break;
    if (!tableOver && isAbilityLine(text)) {
      tableText.push(text);
      continue;
    }
    if (/^(?:habitat|treasure):/i.test(text)) continue;
    if (current) values.set(current, `${values.get(current) ?? ""} ${text}`.trim());
  }

  const acText = values.get("ac") ?? "";
  const ac = acText.match(/^(\d+)/);
  if (ac) block.ac = clampInt(Number(ac[1]), 0, 100);
  else warnings.push("No AC was found.");

  const abilities = readAbilities(tableText.join(" "));
  const saves = readSaves(values.get("saves") ?? "");
  const found = ABILITY_KEYS.filter((k) => abilities[k] !== undefined).length;
  for (const key of ABILITY_KEYS) {
    const score = clampInt(abilities[key]?.score ?? 10, 0, 99);
    block.abilities[key] = { score, save: clampInt(abilities[key]?.save ?? saves[key] ?? abilityMod(score), -20, 40) };
  }
  if (found < 6) warnings.push(found === 0 ? "No ability scores were found." : `Only ${found} of the six ability scores were found.`);

  // On the AC line in a PDF, on a line of its own on a web page.
  const initText =
    acText.match(new RegExp(`initiative\\s*(${MINUS}?\\s?\\d+)`, "i"))?.[1] ?? values.get("initiative")?.match(new RegExp(`^${MINUS}?\\s?\\d+`))?.[0];
  if (initText) block.initiative = clampInt(parseSigned(initText.replace(/\s/g, "")), -20, 40);
  else {
    block.initiative = abilityMod(block.abilities.dex.score);
    warnings.push("No Initiative was given, so it is the Dexterity modifier.");
  }

  const hp = (values.get("hp") ?? "").match(/^(\d+)?\s*(?:\(([^)]*)\))?/);
  const formula = normalizeFormula(hp?.[2] ?? "");
  const average = hp?.[1] !== undefined ? Number(hp[1]) : hpAverage(formula);
  if (average !== null) block.hp = { average: clampInt(average, 0, 100_000), formula: truncate(formula, 40, "The hit dice", warnings) };
  else warnings.push("No Hit Points were found.");

  const speed = values.get("speed");
  if (speed) block.speed = truncate(normalizeSpeed(speed), 200, "The speed", warnings);
  else warnings.push("No speed was found.");

  block.skills = truncate(values.get("skills") ?? "", 500, "Skills", warnings);
  block.vulnerabilities = truncate(capitalizeItems(values.get("vulnerabilities") ?? ""), 500, "Vulnerabilities", warnings);
  block.resistances = truncate(capitalizeItems(values.get("resistances") ?? ""), 500, "Resistances", warnings);
  // The 2024 block joins damage and condition immunities with a semicolon.
  const immunities = [values.get("immunities"), values.get("conditionImmunities")].filter((v): v is string => !!v).map(capitalizeItems);
  block.immunities = truncate(immunities.join("; "), 500, "Immunities", warnings);
  block.gear = truncate(values.get("gear") ?? "", 500, "Gear", warnings);

  const sensesText = values.get("senses") ?? "";
  const passive = sensesText.match(/(?:^|[;,]?\s*)passive perception\s*(\d+)\s*$/i);
  if (passive) {
    block.passivePerception = clampInt(Number(passive[1]), 0, 60);
    block.senses = truncate(normalizeSenses(sensesText.slice(0, passive.index).replace(/[;,]\s*$/, "")), 500, "Senses", warnings);
  } else {
    block.senses = truncate(normalizeSenses(sensesText), 500, "Senses", warnings);
    block.passivePerception = clampInt(10 + abilityMod(block.abilities.wis.score), 0, 60);
    warnings.push("No Passive Perception was given, so it is 10 plus the Wisdom modifier.");
  }

  // A 2014 block prints an em dash for no languages.
  const languages = (values.get("languages") ?? "").replace(/^[\u2014\u2013-]$/, "None");
  block.languages = truncate(languages, 500, "Languages", warnings);

  const crText = values.get("cr") ?? "";
  const cr = crText.match(/^(\d+(?:\/\d+)?)/);
  if (cr && (CR_VALUES as readonly string[]).includes(cr[1]!)) {
    block.cr = cr[1]!;
    const xp = crText.match(/\((?:XP\s*([\d,]+)|([\d,]+)\s*XP)/i);
    block.xp = xp ? clampInt(Number((xp[1] ?? xp[2]!).replace(/,/g, "")), 0, 1_000_000) : (XP_BY_CR[block.cr] ?? 0);
    const lair = crText.match(/or\s*([\d,]+)\s*in lair/i);
    if (lair) block.xpInLair = clampInt(Number(lair[1]!.replace(/,/g, "")), 0, 1_000_000);
  } else {
    warnings.push(NO_CHALLENGE_RATING);
  }

  readBody(lines.slice(at), block, warnings);
  if (block.actions.length === 0) warnings.push("No actions were found.");
  return { block, warnings };
}

/** A spell list item or a bullet, in the stored form, or null. */
function itemLine(text: string): string | null {
  const spell = text.match(SPELL_ITEM);
  if (spell) {
    const label = spell[1]!.toLowerCase() === "at will" ? "At Will" : spell[1]!.replace(/day/i, "Day").replace(/each/i, "Each");
    return `${label}: ${spell[2]}`;
  }
  if (SLOT_ITEM.test(text)) return `• ${text}`;
  const bullet = text.match(BULLET);
  return bullet ? `• ${bullet[1]}` : null;
}

/**
 * The sections: entries opened by their run-in names, spell list items and
 * bullets on their own lines, and the paragraphs between them. A line that
 * follows one ending mid-sentence continues it, except a new list item, and
 * a new entry right after a list, since spell lists end without a stop.
 */
function readBody(lines: Line[], block: StatBlock, warnings: string[]): void {
  const prose = lines.filter((l) => sectionOf(l.text) === undefined && itemLine(l.text) === null && !runIn(l.text));
  // A PDF ends most lines mid-sentence. A web page ends nearly every line with a full stop.
  const wrapped = prose.length > 0 && prose.filter((l) => !endsSentence(l.text)).length / prose.length > 0.25;
  let section: SectionKey = "traits";
  let entry: StatBlockEntry | null = null;
  let texts: string[] = [];
  let previous: string | null = null;
  let afterItem = false;
  const finish = () => {
    if (entry) entry.text = texts.join("\n");
    entry = null;
    texts = [];
  };
  const start = (name: string, first: string) => {
    finish();
    entry = { name: name.slice(0, 120), text: "" };
    texts = [first];
    if (block[section].length < MAX_STAT_BLOCK_ENTRIES) block[section].push(entry);
    else if (!warnings.includes(TOO_MANY)) warnings.push(TOO_MANY);
  };
  const join = (text: string) => {
    const last = texts.length - 1;
    const before = texts[last] ?? "";
    // A word broken across lines at a hyphen keeps it: "Shape-" and "Shift" make "Shape-Shift".
    texts[last] = /[A-Za-z]-$/.test(before) ? `${before}${text}` : `${before} ${text}`.trim();
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let text = line.text;
    const heading = sectionOf(text);
    if (heading !== undefined) {
      if (heading) {
        finish();
        section = heading;
      } else start("", text);
      previous = null;
      afterItem = false;
      continue;
    }
    if (/^(?:habitat|treasure):/i.test(text)) continue;
    const continues = previous !== null && !endsSentence(previous);
    const item = itemLine(text);
    let named = item === null && (!continues || afterItem) ? runIn(text) : null;
    // A narrow PDF column can break a long name ("Legendary Resistance (3/Day, or" and "4/Day in Lair). If ...").
    const next = lines[i + 1];
    if (!named && wrapped && item === null && !continues && next && sectionOf(next.text) === undefined) {
      const both = runIn(`${text} ${next.text}`);
      if (both && both.name.length > text.length) {
        named = both;
        text = `${text} ${next.text}`;
        i++;
      }
    }
    if (named) start(named.name, named.rest);
    else if (!entry) start("", item ?? text);
    else if (item !== null) texts.push(item);
    else if (continues || (wrapped && !line.blankBefore)) join(text);
    else texts.push(text);
    if (named || item !== null) afterItem = item !== null;
    previous = text;
  }
  finish();
  for (const { key } of SECTIONS) {
    for (const e of block[key]) {
      if (e.text.length <= 4_000) continue;
      warnings.push(`The text of ${e.name || "an entry"} was cut to 4,000 characters.`);
      e.text = e.text.slice(0, 4_000);
    }
  }
}
