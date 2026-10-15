import { ABILITY_KEYS, CONDITION_KEYS, type StatBlock, type StatBlockEntry } from "#shared/model.ts";
import { ABILITY_NAMES, abilityMod, crLine, hpLine, SECTIONS, sensesLine, signed, SIZE_WORDS, TEXT_LINES } from "#shared/statBlock.ts";

/**
 * Stat blocks as plain text, laid out the ways a DM's copy and paste gives
 * them, for the parser's tests. The tests write them from the SRD 5.2.1
 * monsters in shared/srd, so no other book's text is ever in the
 * repository.
 */

function sizeLine(m: StatBlock): string {
  const size = m.sizeAlt ? `${SIZE_WORDS[m.size]} or ${SIZE_WORDS[m.sizeAlt]}` : SIZE_WORDS[m.size];
  return `${size} ${m.type}, ${m.alignment}`;
}

/** An entry's paragraphs, one per line, its name run into the first. */
function entryLines(e: StatBlockEntry): string[] {
  const [first = "", ...rest] = e.text.split("\n");
  return [e.name ? `${e.name}. ${first}`.trimEnd() : first, ...rest].filter((line) => line !== "");
}

function headerLines(m: StatBlock): string[] {
  const out: string[] = [];
  for (const { key, label } of TEXT_LINES) if (m[key]) out.push(`${label} ${m[key]}`);
  out.push(`Senses ${sensesLine(m)}`);
  if (m.languages) out.push(`Languages ${m.languages}`);
  out.push(`CR ${crLine(m)}`);
  return out;
}

function bodyLines(m: StatBlock): string[] {
  const out: string[] = [];
  for (const { key, title } of SECTIONS) {
    if (m[key].length === 0) continue;
    out.push(title);
    for (const e of m[key]) out.push(...entryLines(e));
  }
  return out;
}

/** A 2024 block copied from a web page: a line per paragraph, and the ability tables as tab-separated cells. */
export function webText(m: StatBlock): string {
  const ability = (k: (typeof ABILITY_KEYS)[number]) => [ABILITY_NAMES[k].toUpperCase(), m.abilities[k].score, signed(abilityMod(m.abilities[k].score)), signed(m.abilities[k].save)].join("\t");
  return [
    m.name,
    sizeLine(m),
    "",
    `AC ${m.ac}`,
    `Initiative ${signed(m.initiative)} (${10 + m.initiative})`,
    `HP ${hpLine(m.hp)}`,
    `Speed ${m.speed}`,
    "",
    "\tMOD\tSAVE",
    ...ABILITY_KEYS.slice(0, 3).map(ability),
    "\tMOD\tSAVE",
    ...ABILITY_KEYS.slice(3).map(ability),
    "",
    ...headerLines(m),
    "",
    ...bodyLines(m),
  ].join("\n");
}

/** Greedy word wrap, the way a PDF's column breaks a paragraph. */
function wrap(line: string, width: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of line.split(" ")) {
    if (current && `${current} ${word}`.length > width) {
      out.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) out.push(current);
  return out;
}

/** A 2024 block copied from a PDF: every paragraph wrapped at the column's width, and the abilities in two rows. */
export function pdfText(m: StatBlock, width = 48): string {
  const ability = (k: (typeof ABILITY_KEYS)[number]) => `${ABILITY_NAMES[k]} ${m.abilities[k].score} ${signed(abilityMod(m.abilities[k].score))} ${signed(m.abilities[k].save)}`;
  const wrapped = (lines: string[]) => lines.flatMap((line) => wrap(line, width));
  return [
    m.name,
    sizeLine(m),
    `AC ${m.ac} Initiative ${signed(m.initiative)} (${10 + m.initiative})`,
    ...wrapped([`HP ${hpLine(m.hp)}`, `Speed ${m.speed}`]),
    "MOD SAVE MOD SAVE MOD SAVE",
    ABILITY_KEYS.slice(0, 3).map(ability).join(" "),
    ABILITY_KEYS.slice(3).map(ability).join(" "),
    ...wrapped(headerLines(m)),
    ...wrapped(bodyLines(m)),
  ].join("\n");
}

const CONDITIONS = new Set(CONDITION_KEYS.map((k) => k.toLowerCase()));

/** The 2024 line "Poison; Charmed, Poisoned" as the 2014 block's two lines. */
function splitImmunities(text: string): { damage: string; conditions: string } {
  const [first = "", second] = text.split("; ");
  if (second !== undefined) return { damage: first, conditions: second };
  const onlyConditions = first.split(", ").every((w) => CONDITIONS.has(w.toLowerCase()));
  return onlyConditions ? { damage: "", conditions: first } : { damage: first, conditions: "" };
}

/** The 2014 layout: spelled-out labels, lower case, a header row over the ability scores, and traits with no heading. */
export function text2014(m: StatBlock): string {
  const saves = ABILITY_KEYS.filter((k) => m.abilities[k].save !== abilityMod(m.abilities[k].score)).map((k) => `${ABILITY_NAMES[k]} ${signed(m.abilities[k].save)}`);
  const immunities = splitImmunities(m.immunities);
  const lower = (s: string) => s.toLowerCase();
  const lines = [
    m.name,
    `${m.sizeAlt ? `${SIZE_WORDS[m.size]} or ${SIZE_WORDS[m.sizeAlt]}` : SIZE_WORDS[m.size]} ${lower(m.type)}, ${lower(m.alignment)}`,
    `Armor Class ${m.ac}`,
    `Hit Points ${hpLine(m.hp)}`,
    `Speed ${m.speed.replace(/\b(Burrow|Climb|Fly|Swim)\b/g, (w) => w.toLowerCase())}`,
    "STR DEX CON INT WIS CHA",
    ABILITY_KEYS.map((k) => `${m.abilities[k].score} (${signed(abilityMod(m.abilities[k].score))})`).join(" "),
  ];
  if (saves.length > 0) lines.push(`Saving Throws ${saves.join(", ")}`);
  if (m.skills) lines.push(`Skills ${m.skills}`);
  if (m.vulnerabilities) lines.push(`Damage Vulnerabilities ${lower(m.vulnerabilities)}`);
  if (m.resistances) lines.push(`Damage Resistances ${lower(m.resistances)}`);
  if (immunities.damage) lines.push(`Damage Immunities ${lower(immunities.damage)}`);
  if (immunities.conditions) lines.push(`Condition Immunities ${lower(immunities.conditions)}`);
  const senses = m.senses ? `${m.senses.replace(/(^|, )([A-Z])/g, (_, sep: string, c: string) => sep + c.toLowerCase())}, ` : "";
  lines.push(`Senses ${senses}passive Perception ${m.passivePerception}`);
  // 2014 blocks print an em dash for no languages.
  lines.push(`Languages ${m.languages === "None" ? String.fromCharCode(0x2014) : m.languages}`);
  lines.push(`Challenge ${m.cr} (${m.xp.toLocaleString("en-US")} XP)`);
  lines.push(`Proficiency Bonus +${2 + Math.floor(Math.max(0, (m.cr.includes("/") ? 0 : Number(m.cr)) - 1) / 4)}`);
  for (const e of m.traits) lines.push(...entryLines(e));
  for (const { key, title } of SECTIONS.slice(1)) {
    if (m[key].length === 0) continue;
    lines.push(title);
    for (const e of m[key]) lines.push(...entryLines(e));
  }
  return lines.join("\n");
}
