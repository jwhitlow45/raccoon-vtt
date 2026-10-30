import { ABILITY_KEYS, SKILL_KEYS, type PcStats } from "../model.ts";
import type { D20Test, RollNumbers } from "../dice/bonus.ts";
import type { StatBlockMonster } from "../srd/monsters.ts";
import { abilityMod, proficiencyBonus } from "../statBlock.ts";
import { SKILLS } from "./skills.ts";

export type Proficiency = "none" | "prof" | "expert";
export type ProficiencySource = { stats?: PcStats; monster?: { numbers: RollNumbers; cr: string }; wildShape?: boolean };

/** Printed saves include bare modifiers in 2024. Only skills can imply expertise. */
export function listedProficiency(bonus: number | undefined, modifier: number, pb: number, skill: boolean): Proficiency {
  if (bonus === undefined || bonus === modifier) return "none";
  return skill && bonus >= modifier + 2 * pb ? "expert" : "prof";
}

/** Explicit PC flags cannot be recovered from adjusted totals. Wild Shape retains them. */
export function proficiencyFor(test: D20Test, source: ProficiencySource): Proficiency {
  if (test.kind !== "save" && !(test.kind === "check" && test.skill)) return "none";
  const own = test.kind === "save" ? (source.stats?.saves.includes(test.ability) ? "prof" : "none") : (source.stats?.skills[test.skill!] ?? "none");
  if (!source.monster) return own;
  const { numbers, cr } = source.monster;
  const skill = test.kind === "check" ? test.skill : undefined;
  const ability = numbers.abilities[skill ? SKILLS[skill].ability : test.ability];
  const beast = listedProficiency(skill ? numbers.skills[skill] : ability.save, ability.mod, proficiencyBonus(cr), skill !== undefined);
  if (!source.wildShape) return beast;
  return own === "expert" || beast === "expert" ? "expert" : own === "prof" || beast === "prof" ? "prof" : "none";
}

const number = (text: string) => Number(text.replace(/[−–]/g, "-").replace(/\s/g, ""));

/** Read only ability and skill numbers, including the legacy six-column ability table. */
export function numbersFromStatBlock(view: Pick<StatBlockMonster, "statBlock">): RollNumbers | null {
  const text = view.statBlock.replace(/\\([*+\-])/g, "$1");
  const abilities: Partial<RollNumbers["abilities"]> = {};
  for (const key of ABILITY_KEYS) {
    const row = new RegExp(`^\\|\\s*${key}\\s*\\|\\s*(\\d+)\\s*\\|\\s*([+−–-]\\s*\\d+)\\s*\\|\\s*([+−–-]\\s*\\d+)\\s*\\|`, "im").exec(text);
    if (row) abilities[key] = { mod: number(row[2]!), save: number(row[3]!) };
  }
  if (Object.keys(abilities).length !== 6) {
    const legacy = text.split("\n").map((line) => [...line.matchAll(/(\d+)\s*\(\s*([+−–-]\s*\d+)\s*\)/g)]).find((row) => row.length === 6);
    if (!legacy) return null;
    for (const [i, key] of ABILITY_KEYS.entries()) {
      const mod = abilityMod(Number(legacy[i]![1]));
      abilities[key] = { mod, save: mod };
    }
    const saves = /^\s*(?:\*\*)?Saving Throws(?:\*\*)?\s+(.+)$/im.exec(text)?.[1] ?? "";
    for (const key of ABILITY_KEYS) {
      const save = new RegExp(`\\b${key}\\s*([+−–-]\\s*\\d+)`, "i").exec(saves);
      if (save) abilities[key]!.save = number(save[1]!);
    }
  }
  const skills: RollNumbers["skills"] = {};
  const line = /^\s*(?:\*\*)?Skills(?:\*\*)?\s+(.+)$/im.exec(text)?.[1] ?? "";
  for (const key of SKILL_KEYS) {
    const match = new RegExp(`(?:^|,\\s*)${SKILLS[key].name}\\s*([+−–-]\\s*\\d+)(?=\\s*(?:,|$))`, "i").exec(line);
    if (match) skills[key] = number(match[1]!);
  }
  return { abilities: abilities as RollNumbers["abilities"], skills };
}
