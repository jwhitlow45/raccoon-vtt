import {
  ABILITY_KEYS,
  type AbilityKey,
  type Actor,
  type CustomMonster,
  type MonsterSize,
  type StatBlock,
  type StatBlockEntry,
} from "./model.ts";
import type { SrdMonster, StatBlockMonster } from "./srd/monsters.ts";

/**
 * A custom monster's stat block (shared/model.ts) and the SRD monsters'
 * shape (shared/srd/monsters.ts), one through the other.
 *
 * `monsterView` gives a custom monster the light fields and the Markdown
 * stat block an SRD monster has, so the monster browser, the stat block view
 * and token creation treat both the same. `statBlockMarkdown` writes the
 * Markdown exactly the way scripts/srd-import.ts wrote the SRD's, and
 * `statBlockFromSrd` reads an SRD monster back into editable fields. The
 * tests run every SRD monster through both and compare.
 */

export const SIZE_WORDS: Record<MonsterSize, string> = {
  tiny: "Tiny",
  small: "Small",
  medium: "Medium",
  large: "Large",
  huge: "Huge",
  gargantuan: "Gargantuan",
};

export const ABILITY_NAMES: Record<AbilityKey, string> = { str: "Str", dex: "Dex", con: "Con", int: "Int", wis: "Wis", cha: "Cha" };

export type SectionKey = "traits" | "actions" | "bonusActions" | "reactions" | "legendaryActions";

/** The sections in the order a stat block prints them. */
export const SECTIONS: readonly { key: SectionKey; title: string }[] = [
  { key: "traits", title: "Traits" },
  { key: "actions", title: "Actions" },
  { key: "bonusActions", title: "Bonus Actions" },
  { key: "reactions", title: "Reactions" },
  { key: "legendaryActions", title: "Legendary Actions" },
];

/** The SRD's Experience Points by Challenge Rating. CR 0 is worth 0 or 10, and 10 is the usual one. */
export const XP_BY_CR: Readonly<Record<string, number>> = {
  "0": 10,
  "1/8": 25,
  "1/4": 50,
  "1/2": 100,
  "1": 200,
  "2": 450,
  "3": 700,
  "4": 1100,
  "5": 1800,
  "6": 2300,
  "7": 2900,
  "8": 3900,
  "9": 5000,
  "10": 5900,
  "11": 7200,
  "12": 8400,
  "13": 10000,
  "14": 11500,
  "15": 13000,
  "16": 15000,
  "17": 18000,
  "18": 20000,
  "19": 22000,
  "20": 25000,
  "21": 33000,
  "22": 41000,
  "23": 50000,
  "24": 62000,
  "25": 75000,
  "26": 90000,
  "27": 105000,
  "28": 120000,
  "29": 135000,
  "30": 155000,
};

export function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** "+3", "+0", or "−2" with the SRD's minus sign. */
export function signed(n: number): string {
  return n < 0 ? `−${-n}` : `+${n}`;
}

/** Reads "+3", "−2" (the SRD's minus sign), "–2" or "-2". */
export function parseSigned(text: string): number {
  return Number(text.replace(/[−–]/, "-").replace("+", ""));
}

/** The proficiency bonus every stat block derives from its challenge rating. */
export function proficiencyBonus(cr: string): number {
  const n = cr.includes("/") ? 0 : Number(cr);
  return 2 + Math.floor(Math.max(0, n - 1) / 4);
}

/** The average of a hit dice formula such as "2d8 + 4", or null when it is not one. */
export function hpAverage(formula: string): number | null {
  const m = formula.trim().match(/^(\d{1,3})\s*d\s*(\d{1,3})(?:\s*([+−–-])\s*(\d{1,6}))?$/i);
  if (!m) return null;
  const sign = m[3] === "+" || m[3] === undefined ? 1 : -1;
  return Math.max(0, Math.floor((Number(m[1]) * (Number(m[2]) + 1)) / 2) + sign * Number(m[4] ?? 0));
}

function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Characters that would start Markdown formatting in running text, as scripts/srd-import.ts escapes them. */
function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, "\\$1");
}

function unescapeMd(s: string): string {
  return s.replace(/\\([*_`\\])/g, "$1");
}

/** "At Will:", "1/Day:" and "2/Day Each:" open the items of a spell list. */
const SPELL_ITEM = /^(At Will|\d+\/Day(?: Each)?): (.*)$/;
const BULLET = /^[•·▪●] ?(.*)$/;

/**
 * The token's speeds from the speed line, read the way scripts/srd-import.ts
 * reads the SRD's: a speed that holds only in another form ("40 ft. (bear
 * form only)") is not the token's default, "Climb or Fly" gives both, and
 * "(hover)" marks a hovering flier. Anything it cannot read is left out
 * rather than refused, because the DM can still type the speeds on a token.
 */
export function speedsOf(speed: string): Actor["speeds"] {
  const speeds: Actor["speeds"] = { walk: 0 };
  let walked = false;
  for (const raw of speed.split(/,\s*(?![^()]*\))/)) {
    const m = raw.trim().match(/^(?:(burrow|climb|fly|swim|climb or fly) )?(\d{1,6}) ?ft\.?(?: \(([^)]*)\))?$/i);
    if (!m) continue;
    const kind = m[1]?.toLowerCase();
    const feet = Math.min(1_000, Number(m[2]));
    const qualifier = m[3]?.toLowerCase();
    if (qualifier && /form only$/.test(qualifier)) continue;
    if (kind === undefined) {
      if (!walked) speeds.walk = feet;
      walked = true;
    } else if (kind === "climb or fly") {
      speeds.climb = feet;
      speeds.fly = feet;
    } else {
      speeds[kind as "burrow" | "climb" | "fly" | "swim"] = feet;
      if (kind === "fly" && qualifier === "hover") speeds.hover = true;
    }
  }
  return speeds;
}

type Uses = { uses: number; usesInLair?: number };

function uses(m: RegExpMatchArray | null | undefined): Uses | undefined {
  if (!m) return undefined;
  return { uses: Number(m[1]), ...(m[2] ? { usesInLair: Number(m[2]) } : {}) };
}

/**
 * Legendary actions and Legendary Resistance, read from the entries that
 * print them, as the SRD import did: "Legendary Action Uses: 3 (4 in Lair)"
 * opening the Legendary Actions, or the older "can take 3 legendary actions",
 * and a trait named "Legendary Resistance (3/Day, or 4/Day in Lair)".
 */
export function legendaryUses(m: Pick<StatBlock, "traits" | "legendaryActions">): { legendaryActions?: Uses; legendaryResistance?: Uses } {
  let actions: Uses | undefined;
  for (const e of m.legendaryActions) {
    actions ??= uses(e.name.match(/^Legendary Action Uses: (\d+)(?: \((\d+) in Lair\))?$/i));
    actions ??= uses(e.text.match(/can take (\d+) legendary actions/i));
  }
  let resistance: Uses | undefined;
  for (const e of m.traits) resistance ??= uses(e.name.match(/^Legendary Resistance \((\d+)\/Day(?:,? or (\d+)\/Day in Lair)?\)$/i));
  return { ...(actions ? { legendaryActions: actions } : {}), ...(resistance ? { legendaryResistance: resistance } : {}) };
}

/** "Small Fey", or "Small" alone for a block typed or pasted with no creature type. */
export function sizeAndType(m: { size: MonsterSize; type: string }): string {
  return [SIZE_WORDS[m.size], m.type.trim()].filter(Boolean).join(" ");
}

/** "Small Fey, Unaligned". A typed or pasted block may have no creature type or alignment, and then the line has no gap or comma for it. */
function sizeLine(m: StatBlock): string {
  const size = m.sizeAlt ? `${SIZE_WORDS[m.size]} or ${SIZE_WORDS[m.sizeAlt]}` : SIZE_WORDS[m.size];
  const kind = [size, m.type.trim()].filter(Boolean).join(" ");
  return m.alignment.trim() ? `${kind}, ${m.alignment.trim()}` : kind;
}

export function hpLine(hp: StatBlock["hp"]): string {
  return hp.formula ? `${hp.average} (${hp.formula.replace(/-/g, "−")})` : String(hp.average);
}

export function sensesLine(m: Pick<StatBlock, "senses" | "passivePerception">): string {
  return m.senses ? `${m.senses}; Passive Perception ${m.passivePerception}` : `Passive Perception ${m.passivePerception}`;
}

export function crLine(m: Pick<StatBlock, "cr" | "xp" | "xpInLair">): string {
  const lair = m.xpInLair !== undefined ? `, or ${thousands(m.xpInLair)} in lair` : "";
  return `${m.cr} (XP ${thousands(m.xp)}${lair}; PB +${proficiencyBonus(m.cr)})`;
}

/** The labeled lines between the ability table and CR, in the order the block prints them. */
export const TEXT_LINES = [
  { key: "skills", label: "Skills" },
  { key: "vulnerabilities", label: "Vulnerabilities" },
  { key: "resistances", label: "Resistances" },
  { key: "immunities", label: "Immunities" },
  { key: "gear", label: "Gear" },
] as const;

/**
 * One entry's Markdown blocks: the bold name runs into the first paragraph,
 * and each run of spell list items or bullets after it becomes one list.
 */
function entryMarkdown(entry: StatBlockEntry): string[] {
  const lines = entry.text.split("\n");
  const out: string[] = [];
  if (entry.name) out.push(`**${escapeMd(entry.name)}.** ${escapeMd((lines.shift() ?? "").trim())}`.trimEnd());
  let list: string[] = [];
  const flush = () => {
    if (list.length > 0) out.push(list.join("\n"));
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const spell = line.match(SPELL_ITEM);
    const bullet = line.match(BULLET);
    if (spell) list.push(`- **${spell[1]}:** ${escapeMd(spell[2]!)}`);
    else if (bullet) list.push(`- ${escapeMd(bullet[1]!)}`);
    else {
      flush();
      out.push(escapeMd(line));
    }
  }
  flush();
  return out;
}

/** The stat block as Markdown, in the subset documented in shared/srd/monsters.ts. */
export function statBlockMarkdown(m: StatBlock): string {
  const md: string[] = [
    `## ${escapeMd(m.name)}`,
    `*${escapeMd(sizeLine(m))}*`,
    `**AC** ${m.ac} **Initiative** ${signed(m.initiative)} (${10 + m.initiative})`,
    `**HP** ${escapeMd(hpLine(m.hp))}`,
    `**Speed** ${escapeMd(m.speed)}`,
    [
      "| | Score | Mod | Save |",
      "| --- | --- | --- | --- |",
      ...ABILITY_KEYS.map((k) => `| ${ABILITY_NAMES[k]} | ${m.abilities[k].score} | ${signed(abilityMod(m.abilities[k].score))} | ${signed(m.abilities[k].save)} |`),
    ].join("\n"),
  ];
  for (const { key, label } of TEXT_LINES) if (m[key]) md.push(`**${label}** ${escapeMd(m[key])}`);
  md.push(`**Senses** ${escapeMd(sensesLine(m))}`);
  if (m.languages) md.push(`**Languages** ${escapeMd(m.languages)}`);
  md.push(`**CR** ${crLine(m)}`);
  for (const { key, title } of SECTIONS) {
    if (m[key].length === 0) continue;
    md.push(`### ${title}`);
    for (const entry of m[key]) md.push(...entryMarkdown(entry));
  }
  return md.join("\n\n");
}

/**
 * A custom monster in the SRD monsters' shape, for the browser, the stat
 * block view and token creation. It has no SRD id, so its tokens group in
 * the initiative tracker by name, as homebrew tokens do.
 */
export function monsterView(m: StatBlock): StatBlockMonster {
  return {
    name: m.name,
    size: m.size,
    type: m.type,
    alignment: m.alignment,
    ac: m.ac,
    hp: { average: m.hp.average, formula: m.hp.formula },
    speeds: speedsOf(m.speed),
    initiative: { bonus: m.initiative, score: 10 + m.initiative },
    passivePerception: m.passivePerception,
    senses: m.senses,
    languages: m.languages,
    cr: m.cr,
    xp: m.xp,
    ...(m.xpInLair !== undefined ? { xpInLair: m.xpInLair } : {}),
    ...legendaryUses(m),
    statBlock: statBlockMarkdown(m),
  };
}

/** Every ability at 10 with no proficiency, for a new stat block. */
export function plainAbilities(): StatBlock["abilities"] {
  return { str: { score: 10, save: 0 }, dex: { score: 10, save: 0 }, con: { score: 10, save: 0 }, int: { score: 10, save: 0 }, wis: { score: 10, save: 0 }, cha: { score: 10, save: 0 } };
}

/** A blank stat block for the editor to start from. */
export function emptyStatBlock(): StatBlock {
  return {
    name: "",
    size: "medium",
    type: "",
    alignment: "",
    ac: 10,
    initiative: 0,
    hp: { average: 1, formula: "" },
    speed: "30 ft.",
    abilities: plainAbilities(),
    skills: "",
    vulnerabilities: "",
    resistances: "",
    immunities: "",
    gear: "",
    senses: "",
    passivePerception: 10,
    languages: "",
    cr: "0",
    xp: XP_BY_CR["0"]!,
    traits: [],
    actions: [],
    bonusActions: [],
    reactions: [],
    legendaryActions: [],
  };
}

/** A custom monster without its id and rev, for the editor's draft. */
export function statBlockOf(m: CustomMonster): StatBlock {
  const { id: _id, rev: _rev, ...block } = m;
  return block;
}

const SIZE_BY_WORD: Record<string, MonsterSize> = { tiny: "tiny", small: "small", medium: "medium", large: "large", huge: "huge", gargantuan: "gargantuan" };
const SECTION_BY_TITLE = new Map(SECTIONS.map((s) => [s.title, s.key]));

/**
 * An SRD monster's Markdown read back into editable fields, so a DM can
 * start a monster of their own from one. Every SRD block is in the shape
 * scripts/srd-import.ts writes, and the tests check each one comes back
 * unchanged, so a block outside that shape throws rather than guess.
 */
export function statBlockFromSrd(srd: SrdMonster): StatBlock {
  const blocks = srd.statBlock.split("\n\n");
  const fail = (what: string): never => {
    throw new Error(`${srd.name}: cannot read the ${what}`);
  };
  const out = emptyStatBlock();
  out.name = unescapeMd((blocks[0] ?? "").replace(/^## /, ""));
  const sm = unescapeMd(blocks[1] ?? "").match(/^\*(\w+)(?: or (\w+))? (.+), ([^,]+)\*$/);
  if (!sm) return fail("size line");
  out.size = SIZE_BY_WORD[sm[1]!.toLowerCase()] ?? fail("size");
  if (sm[2]) out.sizeAlt = SIZE_BY_WORD[sm[2].toLowerCase()] ?? fail("second size");
  out.type = sm[3]!;
  out.alignment = sm[4]!;
  const am = (blocks[2] ?? "").match(/^\*\*AC\*\* (\d+) \*\*Initiative\*\* ([+−]\d+) \(\d+\)$/) ?? fail("AC line");
  out.ac = Number(am[1]);
  out.initiative = parseSigned(am[2]!);
  const hm = unescapeMd(blocks[3] ?? "").match(/^\*\*HP\*\* (\d+)(?: \((.*)\))?$/) ?? fail("HP line");
  out.hp = { average: Number(hm[1]), formula: (hm[2] ?? "").replace(/−/g, "-") };
  out.speed = unescapeMd((blocks[4] ?? "").replace(/^\*\*Speed\*\* /, ""));
  for (const row of (blocks[5] ?? "").matchAll(/^\| (Str|Dex|Con|Int|Wis|Cha) \| (\d+) \| [+−]\d+ \| ([+−]\d+) \|$/gm)) {
    out.abilities[row[1]!.toLowerCase() as AbilityKey] = { score: Number(row[2]), save: parseSigned(row[3]!) };
  }
  let i = 6;
  for (; i < blocks.length && !blocks[i]!.startsWith("### "); i++) {
    const lm = blocks[i]!.match(/^\*\*(\w+)\*\* (.*)$/s) ?? fail(`line "${blocks[i]}"`);
    const value = unescapeMd(lm[2]!);
    const text = TEXT_LINES.find((t) => t.label === lm[1]);
    if (text) out[text.key] = value;
    else if (lm[1] === "Senses") {
      const pm = value.match(/^(?:(.*); )?Passive Perception (\d+)$/) ?? fail("senses");
      out.senses = pm[1] ?? "";
      out.passivePerception = Number(pm[2]);
    } else if (lm[1] === "Languages") out.languages = value;
    else if (lm[1] === "CR") {
      // A few SRD blocks print "(700 XP; ..." where the rest print "(XP 700; ...".
      const cm = value.match(/^(\S+) \((?:XP ([\d,]+)|([\d,]+) XP)(?:, or ([\d,]+) in lair)?; PB \+\d+\)$/) ?? fail("CR");
      out.cr = cm[1]!;
      out.xp = Number((cm[2] ?? cm[3]!).replace(/,/g, ""));
      if (cm[4]) out.xpInLair = Number(cm[4].replace(/,/g, ""));
    } else fail(`label ${lm[1]}`);
  }
  let section: SectionKey | null = null;
  let entry: StatBlockEntry | null = null;
  for (; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.startsWith("### ")) {
      section = SECTION_BY_TITLE.get(block.slice(4)) ?? fail(`section ${block}`);
      entry = null;
      continue;
    }
    if (!section) return fail("body");
    const named = block.match(/^\*\*(.+?)\.\*\*(?: (.*))?$/s);
    if (named) {
      entry = { name: unescapeMd(named[1]!), text: unescapeMd(named[2] ?? "") };
      out[section].push(entry);
      continue;
    }
    const lines = block.startsWith("- ")
      ? block.split("\n").map((item) => {
          const spell = item.match(/^- \*\*(.+?):\*\* (.*)$/);
          return spell ? `${spell[1]}: ${unescapeMd(spell[2]!)}` : `• ${unescapeMd(item.slice(2))}`;
        })
      : [unescapeMd(block)];
    if (entry) entry.text = [entry.text, ...lines].join("\n");
    else {
      entry = { name: "", text: lines.join("\n") };
      out[section].push(entry);
    }
  }
  return out;
}
