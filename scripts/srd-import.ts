import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { CONDITION_KEYS, STATUS_KEYS, type AbilityKey, type AreaShape, type AreaTrigger, type ConditionKey, type StatusKey } from "../shared/model.ts";
import type { DamageType } from "../shared/rules/damage.ts";
import type { AreaSpell } from "../shared/srd/area-spells.ts";
import type { SaveSpell } from "../shared/srd/save-spells.ts";
import type { SrdMonster } from "../shared/srd/monsters.ts";
import { srdRollsOf } from "../shared/srd/rolls.ts";
import type { RulesText, RulesTextEntry } from "../shared/srd/rules-text.ts";
import type { XpBudgetRow } from "../shared/srd/xp-budget.ts";

/**
 * Regenerates the SRD 5.2.1 data in shared/srd/ from the text of the SRD PDF:
 * monsters.json (every stat block), area-spells.json (spell presets for area
 * templates), save-spells.json (what a pass takes for each spell that deals
 * damage on a save), rules-text.json (the conditions and the statuses the SRD
 * defines) and xp-budget.json (the encounter XP budget per character). The hand-written parts, such as summaries and colors, live in
 * conditions.ts and statuses.ts and are never touched here. rolls.json (each
 * creature's saves, skills and spell numbers) is read from the stat blocks,
 * so `--rolls` writes it again from monsters.json alone.
 *
 *   node scripts/srd-import.ts <srd-5.2.1.txt>
 *   node scripts/srd-import.ts --rolls
 *
 * The input is the PDF's text as pypdf 6.20.1 extracts it, one page at a
 * time, each page preceded by a "=====PAGE n=====" line:
 *
 *   curl -LO https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf
 *   python3 -m venv .venv && .venv/bin/pip install pypdf==6.20.1
 *   .venv/bin/python -c 'import sys; from pypdf import PdfReader; open(sys.argv[2], "w", encoding="utf-8").write("".join(f"\n=====PAGE {i+1}=====\n" + (p.extract_text() or "") for i, p in enumerate(PdfReader(sys.argv[1]).pages)))' SRD_CC_v5.2.1.pdf srd-5.2.1.txt
 *
 * The parsers lean on the layout of that exact text (line wraps, the page
 * headers, where the stat blocks start), so the script warns when the hashes
 * differ from the ones it was written against. A different extraction may
 * still work, but check the diff of the output by hand.
 *
 * The area spells are extracted with patterns, but the published list is the
 * hand-reviewed table AREA_REVIEW below: every spell whose text mentions an
 * area must have an entry there, and every entry must agree with what the
 * patterns found unless it is marked as read by hand. So a new SRD revision
 * cannot add or change a preset without someone reading the spell.
 */

const PDF_SHA256 = "8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87";
const TEXT_SHA256 = "1087a480eb27fffacb098cd448b80a3de0a0fa681cc242ada751759b73a35928";

const OUT_DIR = new URL("../shared/srd/", import.meta.url);

// ---------------------------------------------------------------------------
// Text loading

/**
 * One line of extracted text. pypdf keeps the PDF's own line breaks, and the
 * whitespace around them is the only trace of the paragraph structure: a line
 * that wraps ends in a space (or a hyphen), and a new paragraph inside an
 * entry starts with one.
 */
type Line = { page: number; text: string; indent: boolean; wraps: boolean };

/**
 * Errors in the SRD itself, each fixed once at a spot that must match exactly
 * once, so a corrected SRD revision fails loudly instead of being edited.
 */
const SRD_ERRATA: { from: string; to: string; why: string }[] = [
  {
    from: "Int 6 −2 2 WIS 11 +0 +3 Cha 12 +1 +1",
    to: "Int 6 −2 −2 WIS 11 +0 +3 Cha 12 +1 +1",
    why: "Young White Dragon's Intelligence save lost its minus sign. It is not proficient, so the save equals the modifier.",
  },
  {
    from: "CR 12 (XP 8,000; PB +4)",
    to: "CR 12 (XP 8,400; PB +4)",
    why: "Archmage's XP. The SRD's own Experience Points by Challenge Rating table gives 8,400 for CR 12.",
  },
  {
    from: "AC 9  Initiative −2 (13)",
    to: "AC 9  Initiative −2 (8)",
    why: "Gray Ooze's initiative score. A score is 10 plus the modifier, and −2 matches its Dexterity of 6.",
  },
  {
    from: "AC 14  Initiative +7 (22)",
    to: "AC 14  Initiative +7 (17)",
    why: "Invisible Stalker's initiative score. A score is 10 plus the modifier, and +7 is its Dexterity modifier plus its Proficiency Bonus.",
  },
];

function applyErrata(raw: string): string {
  let out = raw;
  for (const e of SRD_ERRATA) {
    const n = out.split(e.from).length - 1;
    if (n !== 1) throw new Error(`erratum matched ${n} times, expected once: ${e.from}`);
    out = out.replace(e.from, e.to);
  }
  return out;
}

function loadLines(raw: string): Line[] {
  const lines: Line[] = [];
  const pages = raw.split(/^=====PAGE (\d+)=====$/m);
  // split() with a capture group alternates [before, page number, page text, ...].
  for (let i = 1; i < pages.length; i += 2) {
    const page = Number(pages[i]);
    const body = (pages[i + 1] ?? "").split("\n");
    if (body[0] === "") body.shift();
    // Every page starts with its number and the running title, in either order.
    let dropped = 0;
    while (dropped < 2 && body.length > 0 && /^(\d+|System Reference Document 5\.2\.1)$/.test(body[0]!.trim())) {
      body.shift();
      dropped++;
    }
    for (const rawLine of body) {
      const text = normalizeLine(rawLine);
      if (text === "") continue;
      lines.push({
        page,
        text,
        indent: /^\s/.test(rawLine),
        wraps: /(\s|-)$/.test(rawLine),
      });
    }
  }
  return lines;
}

function normalizeLine(s: string): string {
  return (
    s
      .replace(/\t/g, " ")
      // Kerning gaps that pypdf turns into spaces.
      .replace(/https:\/ \//g, "https://")
      .replace(/(\d) ,(\d)/g, "$1,$2")
      .replace(/(\d) ,/g, "$1,")
      .replace(/ {2,}/g, " ")
      .trim()
  );
}

/**
 * Counts of the hyphenated compounds and plain words that appear inside a
 * line. A word broken across lines is rejoined with or without its hyphen by
 * whichever spelling the rest of the document uses, so "suc-" + "ceed" becomes
 * "succeed" but "Higher-" + "Level" stays "Higher-Level".
 */
type WordStats = { pairs: Map<string, number>; words: Map<string, number> };

function wordStats(lines: Line[]): WordStats {
  const pairs = new Map<string, number>();
  const words = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const { text } of lines) {
    // Ignore the last token, which may be half of a broken word.
    const tokens = text.split(" ").slice(0, -1);
    for (const token of tokens) {
      const parts = token.replace(/[^A-Za-z’-]/g, "").toLowerCase().split("-").filter(Boolean);
      for (const p of parts) bump(words, p);
      for (let i = 0; i + 1 < parts.length; i++) bump(pairs, `${parts[i]}-${parts[i + 1]}`);
    }
  }
  return { pairs, words };
}

let stats: WordStats = { pairs: new Map(), words: new Map() };
/** Words rejoined without evidence either way, listed by --verbose for a look. */
const hyphenGuesses = new Set<string>();

/** Joins the lines of one paragraph, undoing the PDF's line-end hyphenation. */
function joinLines(lines: readonly Line[]): string {
  let out = "";
  for (const line of lines) {
    if (out === "") {
      out = line.text;
      continue;
    }
    const broken = out.match(/(\S*?)\s?-$/);
    if (broken) {
      const before = (broken[1] ?? "").match(/[A-Za-z’]+$/)?.[0] ?? "";
      const after = line.text.match(/^[A-Za-z’]+/)?.[0] ?? "";
      const head = out.replace(/\s?-$/, "");
      if (before === "" || after === "" || /^[A-Z]/.test(after)) {
        out = `${head}-${line.text}`;
      } else {
        const hyphenated = stats.pairs.get(`${before}-${after}`.toLowerCase()) ?? 0;
        const joined = stats.words.get(`${before}${after}`.toLowerCase()) ?? 0;
        if (hyphenated === 0 && joined === 0) hyphenGuesses.add(`${before}${after}`);
        out = hyphenated > joined ? `${head}-${line.text}` : `${head}${line.text}`;
      }
    } else {
      out = `${out} ${line.text}`;
    }
  }
  return out;
}

/**
 * Splits lines into paragraphs: a paragraph ends at a line that does not wrap,
 * and an indented line always starts a new one.
 */
function toParagraphs(lines: readonly Line[], forcedBreaks: (text: string) => boolean = () => false): Line[][] {
  const out: Line[][] = [];
  let cur: Line[] = [];
  for (const line of lines) {
    const prev = cur[cur.length - 1];
    if (prev && (!prev.wraps || line.indent || forcedBreaks(line.text) || forcedBreaks(prev.text))) {
      out.push(cur);
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function findLine(lines: readonly Line[], from: number, test: (l: Line) => boolean, what: string): number {
  for (let i = from; i < lines.length; i++) if (test(lines[i]!)) return i;
  throw new Error(`could not find ${what}`);
}

// ---------------------------------------------------------------------------
// Prose cleanup shared by every output

/**
 * The SRD uses em dashes, and the app's style bans them from anything it
 * shows. So each one in the published text is rewritten here by hand, and
 * assertNoEmDash() fails the run if a new one appears.
 */
const EM_DASH_FIXES: [string, string][] = [
  // Statuses (Rage)
  ["using Strength\u2014with either a weapon or an Unarmed Strike\u2014and deal", "using Strength (with either a weapon or an Unarmed Strike) and deal"],
  // Monsters
  ["see the devil. Response\u2014Wisdom Saving Throw", "see the devil. Response: Wisdom Saving Throw"],
  ["Piercing damage\u2014or 12 (2d8 + 3) Piercing damage if the target is Grappled by the mimic\u2014plus 4 (1d8)", "Piercing damage (or 12 (2d8 + 3) Piercing damage if the target is Grappled by the mimic) plus 4 (1d8)"],
  ["metal object\u2014armor or a weapon\u2014worn or carried", "metal object (armor or a weapon) worn or carried"],
  ["Piercing damage\u2014or 6 (1d4 + 4) Piercing damage if the swarm is Bloodied\u2014plus 10 (3d6) Poison damage", "Piercing damage (or 6 (1d4 + 4) Piercing damage if the swarm is Bloodied) plus 10 (3d6) Poison damage"],
];

function fixEmDashes(s: string): string {
  let out = s;
  for (const [from, to] of EM_DASH_FIXES) out = out.split(from).join(to);
  return out;
}

function assertNoEmDash(where: string, s: string): void {
  const at = s.indexOf("\u2014");
  if (at >= 0) throw new Error(`em dash left in ${where}: …${s.slice(Math.max(0, at - 60), at + 60)}…\nAdd a rewrite to EM_DASH_FIXES.`);
}

/** Characters that would start Markdown formatting in running text. */
function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, "\\$1");
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** "+7", "−2" (the SRD's minus sign) or "-2" to a number. */
function signed(s: string): number {
  return Number(s.replace("−", "-").replace("+", ""));
}

// ---------------------------------------------------------------------------
// Spells

const SCHOOLS = "Abjuration|Conjuration|Divination|Enchantment|Evocation|Illusion|Necromancy|Transmutation";
const SPELL_LEVEL_RE = new RegExp(`^(?:Level (\\d) (?:${SCHOOLS})|(?:${SCHOOLS}) Cantrip) \\(`);

type Spell = {
  name: string;
  level: number;
  header: string;
  castingTime: string;
  range: string;
  components: string;
  duration: string;
  concentration: boolean;
  /** The description as paragraphs, each still a list of lines. */
  body: Line[][];
  text: string;
};

/**
 * Spell names in the descriptions are set in small capitals, which pypdf
 * extracts with stray capitals ("Acid SplASh"). The class spell lists use
 * plain type, so they supply the real spelling.
 */
function spellNamesFromLists(lines: readonly Line[]): Map<string, string> {
  const names = new Map<string, string>();
  const re = new RegExp(`^(.+?) (?:${SCHOOLS}) (?:\u2014|–|[CRM](?:, [CRM])*)$`);
  for (const { text } of lines) {
    const m = text.match(re);
    if (m) names.set(m[1]!.toLowerCase(), m[1]!);
  }
  return names;
}

/**
 * The fallback for a spell missing from the class lists: a capital after a
 * lowercase letter is a small-caps artifact, so such words are recased.
 */
function fixSmallCaps(name: string): string {
  if (!/[a-z][A-Z]/.test(name)) return name;
  const fixed = name
    .split(" ")
    .map((w, i) => (i > 0 && /^(of|the|and|or|to|in|a|an|from|with|on|at|for)$/i.test(w) ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
  console.warn(`spell name "${name}" is not in a class spell list, recased to "${fixed}"`);
  return fixed;
}

function parseSpells(lines: readonly Line[]): Spell[] {
  const start = findLine(lines, 0, (l) => l.text === "Spell Descriptions" && l.page >= 100, "Spell Descriptions");
  const end = findLine(lines, start, (l) => l.text === "Rules Glossary" && l.page >= 170, "Rules Glossary");
  const section = lines.slice(start + 1, end);
  const canonical = spellNamesFromLists(lines.slice(0, start));

  const heads: number[] = [];
  for (let i = 1; i < section.length; i++) {
    if (SPELL_LEVEL_RE.test(section[i]!.text) && !section[i - 1]!.wraps) heads.push(i - 1);
  }

  const spells: Spell[] = [];
  heads.forEach((h, k) => {
    const block = section.slice(h, heads[k + 1] ?? section.length);
    const rawName = block[0]!.text;
    const name = canonical.get(rawName.toLowerCase()) ?? fixSmallCaps(rawName);

    // The header: level line (may wrap), then four labeled fields (may wrap).
    let i = 1;
    const levelLines: Line[] = [block[i++]!];
    while (levelLines[levelLines.length - 1]!.wraps && !/^Casting Time:/.test(block[i]!.text)) levelLines.push(block[i++]!);
    const header = joinLines(levelLines);
    const lm = header.match(SPELL_LEVEL_RE)!;
    const fields: Record<string, string> = {};
    // Barkskin spells its label "Component:".
    for (const [label, re] of [
      ["Casting Time", /^Casting Time: /],
      ["Range", /^Range: /],
      ["Components", /^Components?: /],
      ["Duration", /^Duration: /],
    ] as const) {
      const first = block[i]!;
      if (!re.test(first.text)) throw new Error(`${name}: expected ${label}, got "${first.text}"`);
      const fieldLines = [first];
      i++;
      while (fieldLines[fieldLines.length - 1]!.wraps && i < block.length && !/^(Casting Time|Range|Components?|Duration):/.test(block[i]!.text)) {
        fieldLines.push(block[i++]!);
      }
      fields[label] = joinLines(fieldLines).replace(re, "").trim();
    }
    const body = toParagraphs(block.slice(i));
    spells.push({
      name,
      level: lm[1] ? Number(lm[1]) : 0,
      header,
      castingTime: fields["Casting Time"]!,
      range: fields["Range"]!,
      components: fields["Components"]!,
      duration: fields["Duration"]!,
      concentration: fields["Duration"]!.startsWith("Concentration"),
      body,
      text: body.map(joinLines).join("\n"),
    });
  });
  return spells;
}

// ---------------------------------------------------------------------------
// Area spells

type AreaFound = { shape: AreaShape; size: number; width?: number; height?: number };

/**
 * Every phrasing of an area the SRD's spells use. The cylinder and line
 * phrasings put their two numbers in either order.
 */
function findAreas(text: string): AreaFound[] {
  const t = text.replace(/\s+/g, " ").replace(/(\d+)- ?foot/g, "$1-foot").replace(/foot- /g, "foot-");
  const found: AreaFound[] = [];
  const add = (a: AreaFound) => {
    if (!found.some((f) => JSON.stringify(f) === JSON.stringify(a))) found.push(a);
  };
  for (const m of t.matchAll(/(\d+)-foot-radius,? (\d+)-foot[- ](?:high|tall),? Cylinder/g)) add({ shape: "cylinder", size: Number(m[1]), height: Number(m[2]) });
  for (const m of t.matchAll(/(\d+)-foot[- ](?:high|tall),? (\d+)-foot-radius,? Cylinder/g)) add({ shape: "cylinder", size: Number(m[2]), height: Number(m[1]) });
  for (const m of t.matchAll(/Cylinder that is (\d+) feet tall with a (\d+)-foot radius/g)) add({ shape: "cylinder", size: Number(m[2]), height: Number(m[1]) });
  for (const m of t.matchAll(/(\d+)-foot-radius,? Sphere/g)) add({ shape: "sphere", size: Number(m[1]) });
  for (const m of t.matchAll(/(\d+)-foot-long,? (\d+)-foot-wide,? Line/g)) add({ shape: "line", size: Number(m[1]), width: Number(m[2]) });
  for (const m of t.matchAll(/(\d+)-foot-wide,? (\d+)-foot-long,? Line/g)) add({ shape: "line", size: Number(m[2]), width: Number(m[1]) });
  for (const m of t.matchAll(/Line [a-z ]*?(\d+) feet long and (\d+) feet wide/g)) add({ shape: "line", size: Number(m[1]), width: Number(m[2]) });
  for (const m of t.matchAll(/(\d+)-foot[- ](Cone|Cube|Emanation)/g)) add({ shape: m[2]!.toLowerCase() as AreaShape, size: Number(m[1]) });
  return found;
}

/** Words that make a spell worth a look by hand, even when no pattern matched. */
const AREA_HINT_RE =
  /\b(Sphere|Cylinder|Cone|Cube|Line|Emanation|radius|square)\b|feet on a side|(each|every|any) creature (that is |that's )?within \d+ feet of|enters a space within \d+ feet of/;

type AreaReview =
  | {
      shape: AreaShape;
      size: number;
      width?: number;
      height?: number;
      attached?: boolean;
      note?: string;
      /** The phrasing escapes the patterns, so the values were read by hand. */
      manual?: boolean;
      /** When it hits a creature again after it is cast, each checked against the text (TRIGGER_TEXT). */
      triggers?: AreaTrigger[];
      /** An emanation around something other than the caster, as the spell names it ("pack"). */
      target?: string;
      /** That target is not one of the creatures the spell hits, so the area leaves it out. */
      catchesTarget?: false;
      /** What it does to the creatures it catches, for the group save (docs/design-v1-roll-options.md 5.6), each checked against the text (outcomeProblems). */
      outcome?: AreaOutcome;
    }
  | { skip: string };

type AreaOutcome = {
  /** The save it forces, null for none: everyone takes it (Spike Growth). */
  save: AbilityKey | null;
  onPass?: "half";
  damage?: { formula: string; type: DamageType; perSlot?: string }[];
  /** A cantrip's dice grow at character levels 5, 11 and 17 ("Cantrip Upgrade"). */
  cantrip?: true;
  conditions?: ConditionKey[];
  lasts?: { at: "start" | "end"; of: "target" | "self" };
  saveEnds?: true;
};

const ABILITY_WORD: Record<AbilityKey, string> = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" };

/**
 * What a spell's text must say for each part of its reviewed outcome, so a
 * hand-read save, damage or condition cannot drift from the spell: its
 * save's ability, "half as much damage" for half, each damage's dice and
 * type, each slot's added dice, each condition by name, "Cantrip Upgrade",
 * the turn its condition lasts until, and a save at the end of each turn.
 */
function outcomeProblems(name: string, flat: string, o: AreaOutcome): string[] {
  const out: string[] = [];
  const says = (re: RegExp, what: string) => {
    if (!re.test(flat)) out.push(`${name}: review says ${what}, but its text does not`);
  };
  if (o.save) says(new RegExp(`${ABILITY_WORD[o.save]} saving throw`, "i"), `a ${o.save} save`);
  if (o.onPass === "half") says(/half (as much|the initial) damage/i, "half on a pass");
  // Only the reviewed damage counts: Earthquake halves a collapse's damage, which is not its save's.
  else if (o.save && o.damage && /half (as much|the initial) damage/i.test(flat)) out.push(`${name}: its text halves the damage on a pass, but the review does not`);
  for (const part of o.damage ?? []) {
    says(new RegExp(`\\b${part.formula} ${part.type} damage`, "i"), `${part.formula} ${part.type}`);
    if (part.perSlot) says(new RegExp(`increases? by ${part.perSlot} for each spell slot level above`, "i"), `${part.perSlot} more per slot`);
  }
  for (const key of o.conditions ?? []) says(new RegExp(`\\b${key}\\b[^.]*\\bconditions?\\b|\\bconditions?\\b[^.]*\\b${key}\\b|the ${key} condition`, "i"), `the ${key} condition`);
  if (o.cantrip) says(/Cantrip Upgrade/, "a cantrip upgrade");
  if (o.lasts) says(new RegExp(`until the ${o.lasts.at} of ${o.lasts.of === "self" ? "your" : "its"} next turn`, "i"), `until the ${o.lasts.at} of ${o.lasts.of === "self" ? "your" : "its"} next turn`);
  if (o.saveEnds) says(/at the end of each of its turns/i, "a save at the end of each of its turns");
  return out;
}

/**
 * What a spell's text must say for each trigger its review lists, so a
 * reviewed trigger cannot drift from the spell. Black Tentacles prints
 * "ends it turn", so the pronoun is loose.
 */
const TRIGGER_TEXT: Record<AreaTrigger, RegExp> = {
  enter: /\b(enters?|moves into)\b/,
  turnStart: /\bstarts? its turn\b/,
  turnEnd: /\bends? (its|it) turn\b/,
};

/**
 * A spell that hits again limits it to once a turn per creature in so many
 * words: "A creature makes this save only once per turn", "A creature is
 * targeted only once per turn". Grease, Web and Sleet Storm say no such
 * thing, so a creature that enters one and ends its turn there saves twice.
 */
const ONCE_PER_TURN_TEXT = /\bonly once per turn\b/;

/**
 * The hand review of every spell that mentions an area. Each entry was read
 * against the spell's text in SRD 5.2.1. Sizes are in feet: the radius of a
 * sphere or cylinder, the length of a cone or line, the side of a cube, or
 * the distance of an emanation.
 */
const AREA_REVIEW: Record<string, AreaReview> = {
  "Acid Splash": { shape: "sphere", size: 5, outcome: { save: "dex", damage: [{ formula: "1d6", type: "acid" }], cantrip: true } },
  Alarm: { skip: "the largest area it can ward" },
  "Antilife Shell": { shape: "emanation", size: 10, attached: true },
  "Antimagic Field": { shape: "emanation", size: 10, attached: true },
  "Aura of Life": { shape: "emanation", size: 30, attached: true },
  "Black Tentacles": {
    shape: "cube",
    size: 20,
    manual: true,
    note: "A 20-foot square on the ground.",
    triggers: ["enter", "turnEnd"],
    outcome: { save: "str", damage: [{ formula: "3d6", type: "bludgeoning" }], conditions: ["restrained"] },
  },
  "Burning Hands": { shape: "cone", size: 15, outcome: { save: "dex", onPass: "half", damage: [{ formula: "3d6", type: "fire", perSlot: "1d6" }] } },
  "Call Lightning": {
    shape: "sphere",
    size: 5,
    manual: true,
    note: "Each bolt hits creatures within 5 feet of a point under the storm cloud, a 60-foot-radius Cylinder 10 feet tall.",
    outcome: { save: "dex", onPass: "half", damage: [{ formula: "3d10", type: "lightning", perSlot: "1d10" }] },
  },
  "Calm Emotions": { shape: "sphere", size: 20, outcome: { save: "cha" } },
  "Circle of Death": { shape: "sphere", size: 60, outcome: { save: "con", onPass: "half", damage: [{ formula: "8d8", type: "necrotic", perSlot: "2d8" }] } },
  Cloudkill: {
    shape: "sphere",
    size: 20,
    triggers: ["enter", "turnEnd"],
    outcome: { save: "con", onPass: "half", damage: [{ formula: "5d8", type: "poison", perSlot: "1d8" }] },
  },
  "Color Spray": { shape: "cone", size: 15, outcome: { save: "con", conditions: ["blinded"], lasts: { at: "end", of: "self" } } },
  "Commune with Nature": { skip: "knowledge of the surroundings" },
  "Cone of Cold": { shape: "cone", size: 60, outcome: { save: "con", onPass: "half", damage: [{ formula: "8d8", type: "cold", perSlot: "1d8" }] } },
  Confusion: { shape: "sphere", size: 10, outcome: { save: "wis" } },
  "Conjure Animals": {
    shape: "emanation",
    size: 10,
    manual: true,
    note: "Around a Large pack of spectral, intangible animals, which you can move up to 30 feet when you move on your turn.",
    triggers: ["enter", "turnEnd"],
    target: "pack",
    catchesTarget: false,
    outcome: { save: "dex", damage: [{ formula: "3d10", type: "slashing", perSlot: "1d10" }] },
  },
  "Conjure Celestial": {
    shape: "cylinder",
    size: 10,
    height: 40,
    triggers: ["enter", "turnEnd"],
    outcome: { save: "dex", onPass: "half", damage: [{ formula: "6d12", type: "radiant", perSlot: "1d12" }] },
  },
  "Conjure Minor Elementals": { shape: "emanation", size: 15, attached: true },
  "Conjure Woodland Beings": {
    shape: "emanation",
    size: 10,
    attached: true,
    triggers: ["enter", "turnEnd"],
    outcome: { save: "wis", onPass: "half", damage: [{ formula: "5d8", type: "force", perSlot: "1d8" }] },
  },
  "Continual Flame": { skip: "a light radius" },
  "Control Water": { skip: "an area the caster chooses, up to a 100-foot Cube" },
  "Create or Destroy Water": { shape: "cube", size: 30, note: "When the water falls as rain or the spell destroys fog." },
  Creation: { skip: "the largest object it can create" },
  "Dancing Lights": { skip: "a light radius" },
  Darkness: { shape: "sphere", size: 15, note: "Or a 15-foot Emanation from an object." },
  Daylight: { shape: "sphere", size: 60, note: "Or a 60-foot Emanation from an object." },
  "Delayed Blast Fireball": { shape: "sphere", size: 20, outcome: { save: "dex", onPass: "half" } },
  Disintegrate: { skip: "the part of a Huge object it destroys" },
  "Dragon’s Breath": { shape: "cone", size: 15, note: "Exhaled by the creature you touch.", outcome: { save: "dex", onPass: "half" } },
  Druidcraft: { skip: "the largest sensory effect it can create" },
  Earthquake: {
    shape: "cylinder",
    size: 100,
    height: 5,
    manual: true,
    note: "A 100-foot-radius circle on the ground. It affects creatures on the ground.",
    outcome: { save: "dex", conditions: ["prone"] },
  },
  Elementalism: { skip: "harmless effects in a 5-foot Cube" },
  Entangle: { shape: "cube", size: 20, manual: true, note: "A 20-foot square on the ground.", outcome: { save: "str", conditions: ["restrained"] } },
  Fabricate: { skip: "the largest object it can make" },
  "Faerie Fire": { shape: "cube", size: 20, outcome: { save: "dex" } },
  Fear: { shape: "cone", size: 30, outcome: { save: "wis", conditions: ["frightened"] } },
  Fireball: { shape: "sphere", size: 20, outcome: { save: "dex", onPass: "half", damage: [{ formula: "8d6", type: "fire", perSlot: "1d6" }] } },
  "Fire Shield": { skip: "a light radius" },
  "Fire Storm": {
    shape: "cube",
    size: 10,
    note: "Up to ten 10-foot Cubes, each touching another.",
    outcome: { save: "dex", onPass: "half", damage: [{ formula: "7d10", type: "fire" }] },
  },
  "Flame Blade": { skip: "a light radius" },
  "Flame Strike": {
    shape: "cylinder",
    size: 10,
    height: 40,
    outcome: { save: "dex", onPass: "half", damage: [{ formula: "5d6", type: "fire", perSlot: "1d6" }, { formula: "5d6", type: "radiant", perSlot: "1d6" }] },
  },
  "Flaming Sphere": { skip: "a moving object that harms creatures within 5 feet of it" },
  "Fog Cloud": { shape: "sphere", size: 20 },
  Forbiddance: { skip: "a ward on floor space the caster chooses" },
  Forcecage: { shape: "cube", size: 20, manual: true, note: "A cage up to 20 feet on a side, or a solid box up to 10 feet." },
  "Freezing Sphere": { shape: "sphere", size: 60, outcome: { save: "con", onPass: "half", damage: [{ formula: "10d6", type: "cold", perSlot: "1d6" }] } },
  "Globe of Invulnerability": { shape: "emanation", size: 10, note: "Immobile once cast." },
  "Glyph of Warding": { shape: "sphere", size: 20, note: "The explosive rune, centered on the glyph." },
  Grease: {
    shape: "cube",
    size: 10,
    manual: true,
    note: "A 10-foot square on the ground.",
    triggers: ["enter", "turnEnd"],
    outcome: { save: "dex", conditions: ["prone"] },
  },
  "Guards and Wards": { skip: "a ward on floor space the caster chooses" },
  "Gust of Wind": { shape: "line", size: 60, width: 10, triggers: ["turnEnd"], outcome: { save: "str" } },
  Hallow: { skip: "an area the caster chooses, up to a 60-foot radius" },
  "Hallucinatory Terrain": { shape: "cube", size: 150 },
  "Heroes’ Feast": { skip: "where the feast appears" },
  "Holy Aura": { shape: "emanation", size: 30, attached: true },
  "Hypnotic Pattern": { shape: "cube", size: 30, outcome: { save: "wis", conditions: ["charmed", "incapacitated"] } },
  "Ice Knife": {
    shape: "emanation",
    size: 5,
    manual: true,
    note: "Around the target, which is also caught.",
    outcome: { save: "dex", damage: [{ formula: "2d6", type: "cold", perSlot: "1d6" }] },
  },
  "Ice Storm": {
    shape: "cylinder",
    size: 20,
    height: 40,
    outcome: { save: "dex", onPass: "half", damage: [{ formula: "2d10", type: "bludgeoning", perSlot: "1d10" }, { formula: "4d6", type: "cold" }] },
  },
  "Incendiary Cloud": {
    shape: "sphere",
    size: 20,
    triggers: ["enter", "turnEnd"],
    outcome: { save: "dex", onPass: "half", damage: [{ formula: "10d8", type: "fire" }] },
  },
  "Insect Plague": {
    shape: "sphere",
    size: 20,
    triggers: ["enter", "turnEnd"],
    outcome: { save: "con", onPass: "half", damage: [{ formula: "4d10", type: "piercing", perSlot: "1d10" }] },
  },
  Light: { skip: "a light radius" },
  "Lightning Bolt": { shape: "line", size: 100, width: 5, outcome: { save: "dex", onPass: "half", damage: [{ formula: "8d6", type: "lightning", perSlot: "1d6" }] } },
  "Magic Circle": { shape: "cylinder", size: 10, height: 20 },
  "Magnificent Mansion": { skip: "the size of the dwelling" },
  "Major Image": { skip: "the largest illusion it can create" },
  "Mass Cure Wounds": { shape: "sphere", size: 30, note: "Up to six creatures in the area." },
  "Meteor Swarm": {
    shape: "sphere",
    size: 40,
    note: "Four Spheres, each centered on a different point.",
    outcome: { save: "dex", onPass: "half", damage: [{ formula: "20d6", type: "fire" }, { formula: "20d6", type: "bludgeoning" }] },
  },
  "Minor Illusion": { skip: "the largest illusion it can create" },
  "Mirage Arcane": { skip: "terrain up to 1 mile square" },
  Moonbeam: {
    shape: "cylinder",
    size: 5,
    height: 40,
    triggers: ["enter", "turnEnd"],
    outcome: { save: "con", onPass: "half", damage: [{ formula: "2d10", type: "radiant", perSlot: "1d10" }] },
  },
  "Move Earth": { skip: "an area of terrain the caster chooses" },
  "Pass without Trace": { shape: "emanation", size: 30, attached: true },
  "Phantasmal Force": { skip: "the largest illusion it can create" },
  "Plant Growth": { shape: "sphere", size: 100, note: "The Overgrowth effect." },
  "Prismatic Spray": { shape: "cone", size: 60, outcome: { save: "dex", onPass: "half" } },
  "Private Sanctum": { skip: "a Cube the caster chooses, from 5 to 100 feet" },
  "Produce Flame": { skip: "a light radius" },
  "Programmed Illusion": { skip: "the largest illusion it can create" },
  "Purify Food and Drink": { shape: "sphere", size: 5 },
  "Reverse Gravity": { shape: "cylinder", size: 50, height: 100, outcome: { save: "dex" } },
  Shatter: { shape: "sphere", size: 10, outcome: { save: "con", onPass: "half", damage: [{ formula: "3d8", type: "thunder", perSlot: "1d8" }] } },
  "Shining Smite": { skip: "a light radius" },
  Silence: { shape: "sphere", size: 20 },
  "Silent Image": { skip: "the largest illusion it can create" },
  Sleep: { shape: "sphere", size: 5, outcome: { save: "wis", conditions: ["incapacitated"], lasts: { at: "end", of: "target" } } },
  "Sleet Storm": { shape: "cylinder", size: 20, height: 40, triggers: ["enter", "turnStart"], outcome: { save: "dex", conditions: ["prone"] } },
  Slow: { shape: "cube", size: 40, note: "Up to six creatures in the area.", outcome: { save: "wis" } },
  "Speak with Plants": { shape: "emanation", size: 30, note: "Immobile once cast." },
  "Spike Growth": { shape: "sphere", size: 20, triggers: ["enter"], outcome: { save: null, damage: [{ formula: "2d4", type: "piercing" }] } },
  "Spirit Guardians": {
    shape: "emanation",
    size: 15,
    attached: true,
    triggers: ["enter", "turnEnd"],
    outcome: { save: "wis", onPass: "half", damage: [{ formula: "3d8", type: "radiant", perSlot: "1d8" }] },
  },
  "Starry Wisp": { skip: "a light radius" },
  "Stinking Cloud": { shape: "sphere", size: 20, triggers: ["turnStart"], outcome: { save: "con", conditions: ["poisoned"] } },
  "Storm of Vengeance": { skip: "everything under a 300-foot-radius cloud at a height the spell does not give" },
  "Summon Dragon": { skip: "the Cone is the summoned spirit's Breath Weapon" },
  Sunbeam: {
    shape: "line",
    size: 60,
    width: 5,
    outcome: { save: "con", onPass: "half", damage: [{ formula: "6d8", type: "radiant" }], conditions: ["blinded"], lasts: { at: "start", of: "self" } },
  },
  Sunburst: {
    shape: "sphere",
    size: 60,
    outcome: { save: "con", onPass: "half", damage: [{ formula: "12d6", type: "radiant" }], conditions: ["blinded"], saveEnds: true },
  },
  Symbol: { shape: "sphere", size: 60, note: "Centered on the glyph when it triggers.", triggers: ["enter", "turnEnd"] },
  "Teleportation Circle": { skip: "a portal" },
  Thunderwave: { shape: "cube", size: 15, outcome: { save: "con", onPass: "half", damage: [{ formula: "2d8", type: "thunder", perSlot: "1d8" }] } },
  "Tiny Hut": { shape: "emanation", size: 10, note: "Stationary once cast." },
  "Vitriolic Sphere": { shape: "sphere", size: 20, outcome: { save: "dex", onPass: "half", damage: [{ formula: "10d4", type: "acid", perSlot: "2d4" }] } },
  "Wall of Force": { skip: "a wall" },
  "Wall of Ice": { skip: "a wall" },
  Web: { shape: "cube", size: 20, triggers: ["enter", "turnStart"], outcome: { save: "dex", conditions: ["restrained"] } },
  Weird: {
    shape: "sphere",
    size: 30,
    outcome: { save: "wis", onPass: "half", damage: [{ formula: "10d10", type: "psychic" }], conditions: ["frightened"], saveEnds: true },
  },
  "Zone of Truth": { shape: "sphere", size: 15, triggers: ["enter", "turnStart"], outcome: { save: "cha" } },
};

function buildAreaSpells(spells: readonly Spell[]): AreaSpell[] {
  const out: AreaSpell[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const spell of spells) {
    const found = findAreas(spell.text);
    const hinted = found.length > 0 || AREA_HINT_RE.test(spell.text);
    const review = AREA_REVIEW[spell.name];
    if (review) seen.add(spell.name);
    if (!hinted) {
      if (review) problems.push(`${spell.name}: reviewed, but its text no longer mentions an area`);
      continue;
    }
    if (!review) {
      problems.push(
        `${spell.name}: needs review. Found ${JSON.stringify(found)}\n    [${spell.range} | ${spell.duration}]\n    ${spell.text.replace(/\n/g, "\n    ")}`,
      );
      continue;
    }
    if ("skip" in review) continue;
    const match = found.some(
      (f) => f.shape === review.shape && f.size === review.size && f.width === review.width && f.height === review.height,
    );
    if (!match && !review.manual) problems.push(`${spell.name}: review says ${JSON.stringify(review)}, patterns found ${JSON.stringify(found)}`);
    const flat = spell.text.replace(/\s+/g, " ");
    for (const trigger of review.triggers ?? []) {
      if (!TRIGGER_TEXT[trigger].test(flat)) problems.push(`${spell.name}: review says it hits on ${trigger}, but its text does not say so`);
    }
    const o = review.outcome;
    if (o) problems.push(...outcomeProblems(spell.name, flat, o));
    const entry: AreaSpell = {
      srdId: slug(spell.name),
      name: spell.name,
      level: spell.level,
      shape: review.shape,
      size: review.size,
      ...(review.width !== undefined ? { width: review.width } : {}),
      ...(review.height !== undefined ? { height: review.height } : {}),
      attached: review.attached ?? false,
      fromCaster: /^Self\b/.test(spell.range),
      range: spell.range,
      concentration: spell.concentration,
      ...(review.triggers ? { triggers: review.triggers } : {}),
      ...(review.triggers && ONCE_PER_TURN_TEXT.test(flat) ? { oncePerTurn: true as const } : {}),
      ...(review.target ? { target: review.target } : {}),
      ...(review.catchesTarget === false ? { catchesTarget: false as const } : {}),
      ...(review.note ? { note: review.note } : {}),
      ...(o?.save ? { save: o.save } : {}),
      ...(o && o.save === null ? { noSave: true as const } : {}),
      ...(o?.save ? { onPass: o.onPass ?? ("none" as const) } : {}),
      ...(o?.damage ? { damage: o.damage } : {}),
      ...(o?.cantrip ? { cantrip: true as const } : {}),
      ...(o?.conditions ? { conditions: o.conditions } : {}),
      ...(o?.lasts ? { lasts: o.lasts } : {}),
      ...(o?.saveEnds ? { saveEnds: true as const } : {}),
    };
    out.push(entry);
  }
  for (const name of Object.keys(AREA_REVIEW)) {
    if (!seen.has(name)) problems.push(`${name}: in AREA_REVIEW but not an SRD spell`);
  }
  if (problems.length > 0) {
    console.error(problems.join("\n\n"));
    throw new Error(`${problems.length} area spell problems`);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Save spells

/** A save named in a spell's text. */
const SAVE_RE = /\b(?:Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) saving throw/;
/**
 * Damage named in a spell's text: dice or a number before "damage", with any
 * types between ("5d8 Acid, Cold, Fire, Lightning, or Thunder damage"), or
 * damage of a chosen type ("8d8 damage of the spirit's type").
 */
const DAMAGE_RE = /\b\d+(?:d\d+)?(?: \+ \d+)?(?:,? (?:or )?[A-Z][a-z]+)* damage\b|\bdamage of\b/;
/** What a save that halves damage says, in both of the SRD's phrasings ("half the initial damage" is Vitriolic Sphere's). */
const HALF_RE = /\bhalf (?:as much|the initial) damage\b/i;

/**
 * The spells whose text names a save and damage, but whose damage does not
 * hang on a save, each left out with the reason. Every other such spell
 * takes its rule from its own text, and a skip that no longer names such a
 * spell fails the run, so a new SRD revision is read again in full.
 */
const SAVE_SKIP: Record<string, string> = {
  "Arcane Hand": "the hand's damage comes from a spell attack and a grapple, and its saves only push or grab",
  "Bestow Curse": "the save is against the curse, whose extra damage comes with the caster's attacks",
  "Enlarge/Reduce": "the save is an unwilling target's, and the extra damage comes with its attacks",
  Geas: "the save is against the charm, and the damage comes when the target acts against the command",
  "Heat Metal": "the damage takes no save, which only decides whether the object is dropped",
  "Searing Smite": "the hit's damage takes no save, which only ends the burning",
  "Storm of Vengeance": "its rounds deal damage differently, with and without a save",
  Web: "the damage from burning webs takes no save",
};

/**
 * Every SRD spell that deals damage on a save, and what a pass takes, read
 * from its text: half where it says "half as much damage" or "half the
 * initial damage", none where it does not. A character's spell of the same
 * name with no "On a pass" set takes this rule, area spell or not.
 */
function buildSaveSpells(spells: readonly Spell[]): SaveSpell[] {
  const out: SaveSpell[] = [];
  const problems: string[] = [];
  const skipped = new Set<string>();
  for (const spell of spells) {
    const flat = spell.text.replace(/\s+/g, " ");
    if (!SAVE_RE.test(flat) || !(DAMAGE_RE.test(flat) || HALF_RE.test(flat))) continue;
    if (spell.name in SAVE_SKIP) {
      skipped.add(spell.name);
      continue;
    }
    out.push({ srdId: slug(spell.name), name: spell.name, level: spell.level, onPass: HALF_RE.test(flat) ? "half" : "none" });
  }
  for (const name of Object.keys(SAVE_SKIP)) {
    if (!skipped.has(name)) problems.push(`${name}: in SAVE_SKIP, but not an SRD spell whose text names a save and damage`);
  }
  if (problems.length > 0) throw new Error(`save spell problems:\n${problems.join("\n")}`);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Monsters

const SIZE_WORDS = "Tiny|Small|Medium|Large|Huge|Gargantuan";
const SIZE_LINE_RE = new RegExp(`^(${SIZE_WORDS})(?: or (?:${SIZE_WORDS}))? (.+), ([^,]+)$`);
const SECTIONS = new Set(["Traits", "Actions", "Bonus Actions", "Reactions", "Legendary Actions"]);
const HEADER_LABELS = ["Skills", "Vulnerabilities", "Resistances", "Immunities", "Gear", "Senses", "Languages", "CR"];
const HEADER_LABEL_RE = new RegExp(`^(${HEADER_LABELS.join("|")}) `);
const SMALL_WORDS = new Set(["of", "the", "and", "or", "to", "in", "a", "an", "from", "with", "on", "at", "for", "by"]);

/**
 * The bold name that opens an entry ("Fire Breath (Recharge 5–6). Dexterity
 * Saving Throw: ..."), or null when the paragraph does not open with one. A
 * name is a few title-case words with an optional parenthetical, so a
 * sentence that merely contains a full stop is not mistaken for one.
 */
function runIn(text: string): { name: string; rest: string } | null {
  const m = text.match(/^([A-Z0-9][^.]*?)\.(?: (.*))?$/s);
  if (!m) return null;
  const name = m[1]!;
  if (name.length > 70) return null;
  const bare = name.replace(/\([^)]*\)/g, "").trim();
  const words = bare.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 7) return null;
  const titled = words.every((w) => /^[A-Z0-9’'"“]/.test(w) || SMALL_WORDS.has(w));
  return titled ? { name, rest: m[2] ?? "" } : null;
}

/** A group heading between stat blocks, such as "Red Dragons" or "Animals". */
function isGroupHeading(line: Line, prev: Line | undefined): boolean {
  return (
    !line.indent &&
    // "...possibly causing it to miss. " ends the Knight with a stray space.
    (prev === undefined || !prev.wraps || /[.)]$/.test(prev.text)) &&
    line.text.length <= 40 &&
    /^[A-Z][A-Za-z’'-]*(?: (?:[A-Z][A-Za-z’'-]*|of|the))*$/.test(line.text) &&
    !SECTIONS.has(line.text)
  );
}

function parseSpeeds(text: string, where: string): SrdMonster["speeds"] {
  const speeds: SrdMonster["speeds"] = { walk: 0 };
  // Split on commas outside parentheses.
  const parts = text.split(/,\s*(?![^()]*\))/);
  parts.forEach((part, i) => {
    const m = part.trim().match(/^(?:(Burrow|Climb|Fly|Swim|Climb or Fly) )?(\d+) ft\.(?: \(([^)]*)\))?$/);
    if (!m) throw new Error(`${where}: cannot read speed "${part}" in "${text}"`);
    const [, kind, feet, qualifier] = m;
    const value = Number(feet);
    // A lycanthrope's speed in another form ("40 ft. (bear form only)")
    // is not the token's default, so only the stat block shows it.
    if (qualifier && /form only$/.test(qualifier)) return;
    if (qualifier && !(qualifier === "hover" && kind === "Fly") && !(qualifier === "GM’s choice" && kind === "Climb or Fly")) {
      throw new Error(`${where}: unknown speed qualifier "${qualifier}"`);
    }
    if (!kind) {
      if (i !== 0) throw new Error(`${where}: a second walking speed in "${text}"`);
      speeds.walk = value;
    } else if (kind === "Climb or Fly") {
      // The GM picks one of the two for the creature, so the card shows both
      // and the DM deletes one.
      speeds.climb = value;
      speeds.fly = value;
    } else {
      const key = kind.toLowerCase() as "burrow" | "climb" | "fly" | "swim";
      speeds[key] = value;
      if (qualifier === "hover") speeds.hover = true;
    }
  });
  return speeds;
}

type MonsterProblem = { monster: string; text: string };

function parseMonsters(lines: readonly Line[], problems: MonsterProblem[]): SrdMonster[] {
  const start = findLine(lines, 0, (l) => l.text === "Monsters A–Z" && l.page >= 250, "Monsters A–Z");
  const section = lines.slice(start + 1);
  const starts: number[] = [];
  for (let i = 1; i + 1 < section.length; i++) {
    if (SIZE_LINE_RE.test(section[i]!.text) && section[i + 1]!.text.startsWith("AC ")) starts.push(i - 1);
  }

  const monsters: SrdMonster[] = [];
  starts.forEach((s, k) => {
    let block = section.slice(s, starts[k + 1] ?? section.length);
    // Group headings that precede the next stat block belong to no block.
    while (block.length > 1 && isGroupHeading(block[block.length - 1]!, block[block.length - 2])) block = block.slice(0, -1);
    monsters.push(parseStatBlock(block, problems));
  });
  return monsters;
}

function parseStatBlock(block: readonly Line[], problems: MonsterProblem[]): SrdMonster {
  const name = block[0]!.text;
  const problem = (text: string) => problems.push({ monster: name, text });

  const sizeLine = block[1]!.text;
  const sm = sizeLine.match(SIZE_LINE_RE)!;
  const size = sm[1]!.toLowerCase() as SrdMonster["size"];

  const acLine = block[2]!.text;
  const am = acLine.match(/^AC (\d+) Initiative ([+−-]\d+) \((\d+)\)$/);
  if (!am) throw new Error(`${name}: cannot read "${acLine}"`);

  let i = 3;
  const take = (until: (t: string) => boolean): Line[] => {
    const got: Line[] = [];
    while (i < block.length && (got.length === 0 || !until(block[i]!.text))) got.push(block[i++]!);
    return got;
  };
  const hpText = joinLines(take((t) => t.startsWith("Speed ")));
  const hm = hpText.match(/^HP (\d+) \((\d+d\d+(?: [+−] \d+)?)\)$/);
  if (!hm) throw new Error(`${name}: cannot read "${hpText}"`);
  const speedText = joinLines(take((t) => t.startsWith("MOD SAVE"))).replace(/^Speed /, "");
  if (block[i]?.text !== "MOD SAVE MOD SAVE MOD SAVE") throw new Error(`${name}: no ability table`);
  i++;
  const abilityText = `${block[i]!.text} ${block[i + 1]!.text}`;
  i += 2;
  const abilities = [...abilityText.matchAll(/\b(Str|Dex|Con|Int|Wis|Cha)\s+(\d+)\s+([+−]\d+)\s+([+−]\d+)/gi)].map((m) => ({
    name: m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase(),
    score: m[2]!,
    mod: m[3]!,
    save: m[4]!,
  }));
  if (abilities.map((a) => a.name).join() !== "Str,Dex,Con,Int,Wis,Cha") throw new Error(`${name}: cannot read abilities "${abilityText}"`);

  // The labeled lines up to and including CR, each of which can wrap.
  const header = new Map<string, string>();
  while (i < block.length && HEADER_LABEL_RE.test(block[i]!.text)) {
    const label = block[i]!.text.match(HEADER_LABEL_RE)![1]!;
    const got = take((t) => HEADER_LABEL_RE.test(t) || SECTIONS.has(t));
    header.set(label, joinLines(got).slice(label.length + 1));
    if (label === "CR") break;
  }
  const cr = header.get("CR");
  // Gold Dragon Wyrmling prints "(700 XP; ..." where every other block has "(XP 700; ...".
  const crm = cr?.replace(/\(([\d,]+) XP/, "(XP $1").match(/^(\d+(?:\/\d+)?) \(XP ([\d,]+)(?:, or ([\d,]+) in lair)?; PB \+(\d+)\)$/);
  if (!cr || !crm) throw new Error(`${name}: cannot read CR "${cr}"`);
  const sensesText = header.get("Senses") ?? "";
  const pm = sensesText.match(/^(?:(.*); )?Passive Perception (\d+)$/);
  if (!pm) throw new Error(`${name}: cannot read senses "${sensesText}"`);

  // The body: section headings, entries, and the paragraphs and lists inside
  // them.
  const md: string[] = [
    `## ${escapeMd(name)}`,
    `*${escapeMd(sizeLine)}*`,
    `**AC** ${am[1]} **Initiative** ${am[2]} (${am[3]})`,
    `**HP** ${escapeMd(hpText.slice(3))}`,
    `**Speed** ${escapeMd(speedText)}`,
    ["| | Score | Mod | Save |", "| --- | --- | --- | --- |", ...abilities.map((a) => `| ${a.name} | ${a.score} | ${a.mod} | ${a.save} |`)].join("\n"),
    ...[...header].map(([label, value]) => `**${label}** ${escapeMd(value)}`),
  ];
  let legendaryResistance: SrdMonster["legendaryResistance"];
  let legendaryActions: SrdMonster["legendaryActions"];
  let list: string[] = [];
  const flushList = () => {
    if (list.length > 0) md.push(list.join("\n"));
    list = [];
  };
  const paragraphs = toParagraphs(block.slice(i), (t) => SECTIONS.has(t));
  for (const para of paragraphs) {
    const text = joinLines(para);
    const first = para[0]!;
    para.forEach((line, k) => {
      if (k > 0 && /\.$/.test(para[k - 1]!.text) && runIn(line.text)) problem(`possible entry inside a paragraph: "${line.text}"`);
    });
    if (SECTIONS.has(text)) {
      flushList();
      md.push(`### ${text}`);
      continue;
    }
    if (!/[.:)”]$/.test(text) && !/^(At Will|\d+\/Day(?: Each)?):/.test(text)) {
      problem(`paragraph ends mid-sentence: "${text}"`);
    }
    if (text.startsWith("•")) {
      list.push(`- ${escapeMd(text.slice(1).trim())}`);
      continue;
    }
    const spellList = text.match(/^(At Will|\d+\/Day(?: Each)?): (.*)$/);
    if (spellList) {
      list.push(`- **${spellList[1]}:** ${escapeMd(spellList[2]!)}`);
      continue;
    }
    flushList();
    const entry = first.indent ? null : runIn(text);
    if (entry) {
      md.push(`**${escapeMd(entry.name)}.** ${escapeMd(entry.rest)}`.trimEnd());
      const lr = entry.name.match(/^Legendary Resistance \((\d+)\/Day(?:, or (\d+)\/Day in Lair)?\)$/);
      if (lr) legendaryResistance = { uses: Number(lr[1]), ...(lr[2] ? { usesInLair: Number(lr[2]) } : {}) };
      const la = entry.name.match(/^Legendary Action Uses: (\d+)(?: \((\d+) in Lair\))?$/);
      if (la) legendaryActions = { uses: Number(la[1]), ...(la[2] ? { usesInLair: Number(la[2]) } : {}) };
    } else {
      if (!first.indent) problem(`paragraph without an entry name: "${text}"`);
      md.push(escapeMd(text));
    }
  }
  flushList();
  if (/Legendary Resistance/.test(md.join("\n")) && !legendaryResistance) problem("mentions Legendary Resistance but no uses were read");
  if (md.includes("### Legendary Actions") && !legendaryActions) problem("has Legendary Actions but no uses were read");

  const statBlock = fixEmDashes(md.join("\n\n"));
  assertNoEmDash(name, statBlock);
  return {
    srdId: slug(name),
    name,
    size,
    type: sm[2]!,
    alignment: sm[3]!,
    ac: Number(am[1]),
    hp: { average: Number(hm[1]), formula: hm[2]!.replace("−", "-") },
    speeds: parseSpeeds(speedText, name),
    initiative: { bonus: signed(am[2]!), score: Number(am[3]) },
    passivePerception: Number(pm[2]),
    senses: pm[1] ?? "",
    languages: header.get("Languages") ?? "",
    cr: crm[1]!,
    xp: Number(crm[2]!.replace(/,/g, "")),
    ...(crm[3] ? { xpInLair: Number(crm[3].replace(/,/g, "")) } : {}),
    ...(legendaryActions ? { legendaryActions } : {}),
    ...(legendaryResistance ? { legendaryResistance } : {}),
    statBlock,
  };
}

/** The SRD's Experience Points by Challenge Rating table. CR 0 is worth 0 or 10. */
const XP_BY_CR: Record<string, number[]> = {
  "0": [0, 10],
  "1/8": [25],
  "1/4": [50],
  "1/2": [100],
  "1": [200],
  "2": [450],
  "3": [700],
  "4": [1100],
  "5": [1800],
  "6": [2300],
  "7": [2900],
  "8": [3900],
  "9": [5000],
  "10": [5900],
  "11": [7200],
  "12": [8400],
  "13": [10000],
  "14": [11500],
  "15": [13000],
  "16": [15000],
  "17": [18000],
  "18": [20000],
  "19": [22000],
  "20": [25000],
  "21": [33000],
  "22": [41000],
  "23": [50000],
  "24": [62000],
  "25": [75000],
  "26": [90000],
  "27": [105000],
  "28": [120000],
  "29": [135000],
  "30": [155000],
};

/**
 * Arithmetic every stat block must satisfy. A failure is either a parse
 * error or an error in the SRD, and either way it needs a person to look.
 */
function checkMonster(m: SrdMonster): string[] {
  const out: string[] = [];
  if (!XP_BY_CR[m.cr]?.includes(m.xp)) out.push(`XP ${m.xp} does not match CR ${m.cr}`);
  if (m.initiative.score !== 10 + m.initiative.bonus) out.push(`initiative score ${m.initiative.score} is not 10 + ${m.initiative.bonus}`);
  const dice = m.hp.formula.match(/^(\d+)d(\d+)(?: ([+-]) (\d+))?$/);
  if (!dice) out.push(`HP formula ${m.hp.formula}`);
  else {
    const [, n, d, sign, k] = dice;
    const avg = Math.floor((Number(n) * (Number(d) + 1)) / 2) + (sign === "-" ? -1 : 1) * Number(k ?? 0);
    if (avg !== m.hp.average) out.push(`HP ${m.hp.average} is not the average of ${m.hp.formula} (${avg})`);
  }
  for (const row of m.statBlock.matchAll(/^\| (Str|Dex|Con|Int|Wis|Cha) \| (\d+) \| ([+−]\d+) \| ([+−]\d+) \|$/gm)) {
    const mod = Math.floor((Number(row[2]) - 10) / 2);
    if (signed(row[3]!) !== mod) out.push(`${row[1]} ${row[2]} has modifier ${row[3]}`);
    if (signed(row[4]!) < mod) out.push(`${row[1]} save ${row[4]} is below its modifier ${row[3]}`);
  }
  return out;
}

/**
 * The "Index of Stat Blocks" in the table of contents, keyed without spaces,
 * because the index has kerning gaps ("Dragon Tur t le") and the stat blocks
 * do not. It is the check that no stat block was missed or invented, and
 * never the source of a name: a spelling taken from it would put the gaps in
 * the monster's name and its srdId.
 */
function statBlockIndex(lines: readonly Line[]): Map<string, string> {
  const start = findLine(lines, 0, (l) => l.text === "Blocks" && l.page === 2, "Index of Stat Blocks");
  const names = new Map<string, string>();
  for (let i = start + 1; i < lines.length && lines[i]!.page <= 4; i++) {
    const m = lines[i]!.text.match(/^(.+?) ?\.{3,} ?\d+$/);
    if (m) names.set(m[1]!.replace(/\s+/g, "").toLowerCase(), m[1]!);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Conditions and statuses

/** Markdown for prose paragraphs, bolding the run-in names of indented ones. */
function proseMarkdown(paragraphs: readonly Line[][]): string {
  const out: string[] = [];
  let list: string[] = [];
  for (const para of paragraphs) {
    const text = joinLines(para);
    if (text.startsWith("•")) {
      list.push(`- ${escapeMd(text.slice(1).trim())}`);
      continue;
    }
    if (list.length > 0) out.push(list.join("\n"));
    list = [];
    const entry = out.length > 0 ? runIn(text) : null;
    out.push(entry ? `**${escapeMd(entry.name)}.** ${escapeMd(entry.rest)}`.trimEnd() : escapeMd(text));
  }
  if (list.length > 0) out.push(list.join("\n"));
  return out.join("\n\n");
}

/**
 * The lines of one Rules Glossary entry. An entry runs until the next line
 * that looks like an entry heading: a short title-case line, not indented,
 * after a line that ends its paragraph.
 */
function glossaryEntry(lines: readonly Line[], heading: string): Line[] {
  const start = findLine(lines, 0, (l) => l.text === "Rules Glossary" && l.page >= 170, "Rules Glossary");
  const at = findLine(lines, start, (l) => l.text === heading, `glossary entry ${heading}`);
  const out: Line[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const prev = lines[i - 1]!;
    const isHeading =
      !line.indent && !prev.wraps && /^[A-Z][A-Za-z’' -]*(?: \[[A-Za-z ]+\])?$/.test(line.text) && line.text.length <= 40;
    if (isHeading) break;
    out.push(line);
  }
  return out;
}

function spellMarkdown(spell: Spell): string {
  const header = [
    `*${escapeMd(spell.header)}*`,
    `**Casting Time:** ${escapeMd(spell.castingTime)}`,
    `**Range:** ${escapeMd(spell.range)}`,
    `**Components:** ${escapeMd(spell.components)}`,
    `**Duration:** ${escapeMd(spell.duration)}`,
  ];
  return [...header, proseMarkdown(spell.body)].join("\n\n");
}

/**
 * Rage is a Barbarian feature, and the Barbarian Features table sits between
 * its paragraphs in the extracted text, so the table's lines are cut out.
 */
function rageText(lines: readonly Line[]): string {
  const start = findLine(lines, 0, (l) => l.text === "Level 1: Rage", "Level 1: Rage");
  const end = findLine(lines, start, (l) => l.text === "Level 1: Unarmored Defense", "Level 1: Unarmored Defense");
  const tableStart = findLine(lines, start, (l) => l.text === "Barbarian Features", "Barbarian Features table");
  const tableEnd = findLine(lines, tableStart, (l) => l.text.startsWith("20 +6 Primal Champion"), "end of the Barbarian Features table");
  const body = [...lines.slice(start + 1, tableStart), ...lines.slice(tableEnd + 1, end)];
  return proseMarkdown(toParagraphs(body));
}

const CONDITION_NAMES: Record<ConditionKey, string> = {
  blinded: "Blinded",
  charmed: "Charmed",
  deafened: "Deafened",
  exhaustion: "Exhaustion",
  frightened: "Frightened",
  grappled: "Grappled",
  incapacitated: "Incapacitated",
  invisible: "Invisible",
  paralyzed: "Paralyzed",
  petrified: "Petrified",
  poisoned: "Poisoned",
  prone: "Prone",
  restrained: "Restrained",
  stunned: "Stunned",
  unconscious: "Unconscious",
};

/** Where each status's rules live in the SRD. Marked is the app's own. */
const STATUS_SOURCES: Partial<Record<StatusKey, { title: string; source: string; from: (lines: readonly Line[], spells: readonly Spell[]) => string }>> = {
  concentrating: { title: "Concentration", source: "Rules Glossary", from: (l) => proseMarkdown(toParagraphs(glossaryEntry(l, "Concentration"))) },
  hidden: { title: "Hide", source: "Rules Glossary, action", from: (l) => proseMarkdown(toParagraphs(glossaryEntry(l, "Hide [Action]"))) },
  flying: { title: "Flying", source: "Rules Glossary", from: (l) => proseMarkdown(toParagraphs(glossaryEntry(l, "Flying"))) },
  dodging: { title: "Dodge", source: "Rules Glossary, action", from: (l) => proseMarkdown(toParagraphs(glossaryEntry(l, "Dodge [Action]"))) },
  raging: { title: "Rage", source: "Barbarian, level 1 feature", from: (l) => rageText(l) },
  blessed: { title: "Bless", source: "Spell", from: (_, s) => spellMarkdown(spellNamed(s, "Bless")) },
  baned: { title: "Bane", source: "Spell", from: (_, s) => spellMarkdown(spellNamed(s, "Bane")) },
  hasted: { title: "Haste", source: "Spell", from: (_, s) => spellMarkdown(spellNamed(s, "Haste")) },
  "hunters-mark": { title: "Hunter’s Mark", source: "Spell", from: (_, s) => spellMarkdown(spellNamed(s, "Hunter’s Mark")) },
  hexed: { title: "Hex", source: "Spell", from: (_, s) => spellMarkdown(spellNamed(s, "Hex")) },
  "heroic-inspiration": {
    title: "Heroic Inspiration",
    source: "Rules Glossary",
    from: (l) => proseMarkdown(toParagraphs(glossaryEntry(l, "Heroic Inspiration"))),
  },
  surprised: { title: "Surprise", source: "Rules Glossary", from: (l) => proseMarkdown(toParagraphs(glossaryEntry(l, "Surprise"))) },
  readied: { title: "Ready", source: "Rules Glossary, action", from: (l) => proseMarkdown(toParagraphs(glossaryEntry(l, "Ready [Action]"))) },
};

function spellNamed(spells: readonly Spell[], name: string): Spell {
  const spell = spells.find((s) => s.name === name);
  if (!spell) throw new Error(`no spell named ${name}`);
  return spell;
}

function buildRulesText(lines: readonly Line[], spells: readonly Spell[]): RulesText {
  const finish = (where: string, e: RulesTextEntry): RulesTextEntry => {
    const text = fixEmDashes(e.text);
    assertNoEmDash(where, text);
    return { ...e, text };
  };
  const conditions = {} as RulesText["conditions"];
  for (const key of CONDITION_KEYS) {
    const name = CONDITION_NAMES[key];
    const text = proseMarkdown(toParagraphs(glossaryEntry(lines, `${name} [Condition]`)));
    conditions[key] = finish(name, { title: name, source: "Rules Glossary, condition", text });
  }
  const statuses: RulesText["statuses"] = {};
  for (const key of STATUS_KEYS) {
    const src = STATUS_SOURCES[key];
    if (!src) continue;
    statuses[key] = finish(src.title, { title: src.title, source: src.source, text: src.from(lines, spells) });
  }
  return { conditions, statuses };
}

// ---------------------------------------------------------------------------
// Encounter XP budgets

/**
 * The XP Budget per Character table under "Combat Encounter Difficulty": one
 * row per level, 1 to 20, with the Low, Moderate and High budgets. pypdf
 * splits one number at a kerning gap ("11,70 0"), so a thousands group cut
 * short is joined with the digits after it. The worked examples under the
 * table each multiply one of its numbers, so they check the result.
 */
function parseXpBudget(lines: readonly Line[]): XpBudgetRow[] {
  const title = findLine(lines, 0, (l) => l.text === "XP Budget per Character", "the XP Budget per Character table");
  const header = findLine(lines, title, (l) => l.text === "Low Moderate High", "the XP budget table's header");
  const rows: XpBudgetRow[] = [];
  for (let level = 1; level <= 20; level++) {
    const text = lines[header + level]?.text ?? "";
    const cells: string[] = [];
    for (const token of text.split(" ")) {
      const prev = cells[cells.length - 1];
      if (prev !== undefined && /,\d{1,2}$/.test(prev)) cells[cells.length - 1] = `${prev}${token}`;
      else cells.push(token);
    }
    const [first, ...numbers] = cells;
    if (first !== String(level) || numbers.length !== 3 || !numbers.every((n) => /^\d{1,3}(,\d{3})*$/.test(n))) {
      throw new Error(`XP budget row for level ${level} reads "${text}"`);
    }
    const [low, moderate, high] = numbers.map((n) => Number(n.replace(/,/g, ""))) as [number, number, number];
    const prev = rows[rows.length - 1];
    if (!(low < moderate && moderate < high) || (prev && !(prev.low < low && prev.moderate < moderate && prev.high < high))) {
      throw new Error(`XP budget row for level ${level} does not grow with difficulty and level: "${text}"`);
    }
    rows.push({ level, low, moderate, high });
  }

  const end = findLine(lines, header, (l) => l.text === "Troubleshooting", "the end of the XP budget examples");
  const examples = joinLines(lines.slice(header + 21, end));
  const worked = [...examples.matchAll(/A (low|moderate|high)-difficulty encounter for \w+ level (\d+) characters has an XP budget of ([\d,]+) × (\d+), for a total of ([\d,]+) XP/g)];
  if (worked.length !== 3) throw new Error(`expected 3 worked XP budget examples, found ${worked.length}`);
  const n = (s: string | undefined) => Number((s ?? "").replace(/,/g, ""));
  for (const [, difficulty, level, each, count, total] of worked) {
    const budget = rows[n(level) - 1]?.[difficulty as "low" | "moderate" | "high"];
    if (budget !== n(each) || n(each) * n(count) !== n(total)) {
      throw new Error(`the ${difficulty} example for level ${level} disagrees with the table (${budget})`);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Main

function main(): void {
  const path = process.argv[2];
  if (path === "--rolls") {
    const monsters = JSON.parse(readFileSync(new URL("monsters.json", OUT_DIR), "utf8")) as SrdMonster[];
    writeRolls(monsters);
    return;
  }
  if (!path) {
    console.error("usage: node scripts/srd-import.ts <srd-5.2.1.txt>  (see the comment at the top of this file)");
    process.exit(2);
  }
  const raw = readFileSync(path, "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  if (hash !== TEXT_SHA256) {
    console.warn(`warning: the text's SHA-256 is ${hash}, not the ${TEXT_SHA256} this script was written against (from the PDF with SHA-256 ${PDF_SHA256}). Review the output diff by hand.`);
  }
  const lines = loadLines(applyErrata(raw));
  stats = wordStats(lines);

  const spells = parseSpells(lines);
  console.log(`spells: ${spells.length}`);
  const areaSpells = buildAreaSpells(spells);
  console.log(`area spells: ${areaSpells.length}`);
  const saveSpells = buildSaveSpells(spells);
  console.log(`save spells: ${saveSpells.length}`);

  const index = statBlockIndex(lines);
  const problems: MonsterProblem[] = [];
  const monsters = parseMonsters(lines, problems);
  console.log(`monsters: ${monsters.length}`);
  const failures = problems.map((p) => `${p.monster}: ${p.text}`);
  const parsed = new Set(monsters.map((m) => m.name.replace(/\s+/g, "").toLowerCase()));
  for (const [key, n] of index) if (!parsed.has(key)) failures.push(`index entry with no stat block: ${n}`);
  for (const m of monsters) if (!index.has(m.name.replace(/\s+/g, "").toLowerCase())) failures.push(`stat block not in the index: ${m.name}`);
  failures.push(...monsters.flatMap((m) => checkMonster(m).map((e) => `${m.name}: ${e}`)));
  const ids = new Set<string>();
  for (const m of monsters) {
    if (ids.has(m.srdId)) failures.push(`duplicate srdId ${m.srdId}`);
    ids.add(m.srdId);
  }
  if (failures.length > 0) throw new Error(`stat block checks failed:\n${failures.join("\n")}`);

  const rulesText = buildRulesText(lines, spells);
  const xpBudget = parseXpBudget(lines);
  console.log(`XP budget levels: ${xpBudget.length}`);
  if (process.argv.includes("--verbose")) {
    const published = JSON.stringify([monsters, rulesText]);
    const used = [...hyphenGuesses].filter((w) => published.includes(w));
    console.log(`line-end hyphens removed without evidence, in published text: ${used.join(", ")}`);
  }
  writeFileSync(new URL("monsters.json", OUT_DIR), jsonLines(monsters.sort((a, b) => a.name.localeCompare(b.name))));
  writeRolls(monsters);
  writeFileSync(new URL("area-spells.json", OUT_DIR), jsonLines(areaSpells));
  writeFileSync(new URL("save-spells.json", OUT_DIR), jsonLines(saveSpells));
  writeFileSync(new URL("rules-text.json", OUT_DIR), `${JSON.stringify(rulesText, null, 2)}\n`);
  writeFileSync(new URL("xp-budget.json", OUT_DIR), jsonLines(xpBudget));
}

/** A JSON array with one element per line, so a diff shows which entry changed. */
function jsonLines(items: readonly unknown[]): string {
  return `[\n${items.map((x) => JSON.stringify(x)).join(",\n")}\n]\n`;
}

/** rolls.json, one creature a line in monsters.json's order, as jsonLines writes an array. */
function writeRolls(monsters: readonly SrdMonster[]): void {
  const rolls = srdRollsOf(monsters);
  const lines = Object.entries(rolls).map(([id, numbers]) => `${JSON.stringify(id)}:${JSON.stringify(numbers)}`);
  writeFileSync(new URL("rolls.json", OUT_DIR), `{\n${lines.join(",\n")}\n}\n`);
  console.log(`roll numbers: ${lines.length}`);
}

main();
