import type { AbilityKey, SkillKey } from "#shared/model.ts";
import type { Proficiency } from "#shared/rules/proficiency.ts";
import { ABILITY_NAMES, SKILLS } from "#shared/rules/skills.ts";

/** Where a stat block or sheet lists proficiencies in text. Marks are for roll controls only (D-261030-539). */
export type ProficiencyLine = { label: "Proficiencies" | "Expertise"; names: string[] };

/**
 * The two lines that follow a Skills line: "Proficiencies" (proficient saves
 * first, as "Dexterity saves", then proficient skills without expertise) and
 * "Expertise" (expertise skills). Each is left out when empty. Callers pass
 * the saves and skills in the order their sheet lists them and leave out any
 * test whose level they cannot read, so a private or missing stat is never
 * guessed. A save at "expert" cannot happen, and counts as proficient.
 */
export function proficiencyLines(input: {
  saves: readonly { ability: AbilityKey; level: Proficiency }[];
  skills: readonly { skill: SkillKey; level: Proficiency }[];
}): ProficiencyLine[] {
  const proficient = [
    ...input.saves.filter((s) => s.level !== "none").map((s) => `${ABILITY_NAMES[s.ability]} saves`),
    ...input.skills.filter((s) => s.level === "prof").map((s) => SKILLS[s.skill].name),
  ];
  const expert = input.skills.filter((s) => s.level === "expert").map((s) => SKILLS[s.skill].name);
  const lines: ProficiencyLine[] = [];
  if (proficient.length > 0) lines.push({ label: "Proficiencies", names: proficient });
  if (expert.length > 0) lines.push({ label: "Expertise", names: expert });
  return lines;
}

/** A line as a stat block's Markdown writes it, "**Proficiencies** Dexterity saves, Perception". */
export function proficiencyMarkdown(lines: readonly ProficiencyLine[]): string {
  return lines.map((line) => `**${line.label}** ${line.names.join(", ")}`).join("\n\n");
}

/** Lines that follow a Skills line in the 2024 block, which a block without one takes their place before. */
const AFTER_SKILLS = /^\s*(?:\*\*)?(?:Vulnerabilities|Resistances|Immunities|Gear|Senses|Languages|CR|Challenge)(?:\*\*)?\b/i;
const SKILLS_LINE = /^\s*(?:\*\*)?Skills(?:\*\*)?\s/i;

/**
 * A stat block's Markdown with the proficiency lines put after its Skills
 * line, or where one would stand: before the first of the lines that follow
 * it, else after the ability table, else unchanged. Only added text, so the
 * stored block is never touched.
 */
export function withProficiencyLines(markdown: string, lines: readonly ProficiencyLine[]): string {
  if (lines.length === 0) return markdown;
  const rows = markdown.split("\n");
  const skills = rows.findIndex((row) => SKILLS_LINE.test(row));
  const lastTable = rows.reduce((last, row, i) => (row.startsWith("|") ? i : last), -1);
  const at = skills >= 0 ? skills + 1 : rows.findIndex((row) => AFTER_SKILLS.test(row));
  const insert = at >= 0 ? at : lastTable >= 0 ? lastTable + 1 : -1;
  if (insert < 0) return markdown;
  const head = rows.slice(0, insert);
  const tail = rows.slice(insert);
  // Markdown paragraphs need a blank line on each side.
  const open = head.length > 0 && head[head.length - 1] !== "" ? [""] : [];
  const close = tail.length > 0 && tail[0] !== "" ? [""] : [];
  return [...head, ...open, proficiencyMarkdown(lines), ...close, ...tail].join("\n");
}
