import { SKILL_KEYS, type AbilityKey, type RollChoice, type RollTest, type SkillKey } from "../model.ts";

/**
 * Abilities and skills as the SRD 5.2.1 names them, and the words of a
 * requested roll (docs/design-v1-dm-tools.md 3.3). A D20 Test is named for
 * an ability, and a check may name a skill: "a Strength (Acrobatics or
 * Athletics) check" (page 6). The Skills table on page 9 gives each skill
 * its usual ability, which a request starts from when the DM picks a skill.
 * The SRD lets a check pair a skill with another ability, so the table is
 * only the default.
 */

export const ABILITY_NAMES: Record<AbilityKey, string> = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
};

/** The Skills table (SRD 5.2.1 page 9): each skill's name and the ability it is usually used with. */
export const SKILLS: Record<SkillKey, { name: string; ability: AbilityKey }> = {
  acrobatics: { name: "Acrobatics", ability: "dex" },
  "animal-handling": { name: "Animal Handling", ability: "wis" },
  arcana: { name: "Arcana", ability: "int" },
  athletics: { name: "Athletics", ability: "str" },
  deception: { name: "Deception", ability: "cha" },
  history: { name: "History", ability: "int" },
  insight: { name: "Insight", ability: "wis" },
  intimidation: { name: "Intimidation", ability: "cha" },
  investigation: { name: "Investigation", ability: "int" },
  medicine: { name: "Medicine", ability: "wis" },
  nature: { name: "Nature", ability: "int" },
  perception: { name: "Perception", ability: "wis" },
  performance: { name: "Performance", ability: "cha" },
  persuasion: { name: "Persuasion", ability: "cha" },
  religion: { name: "Religion", ability: "int" },
  "sleight-of-hand": { name: "Sleight of Hand", ability: "dex" },
  stealth: { name: "Stealth", ability: "dex" },
  survival: { name: "Survival", ability: "wis" },
};

/** The ability a skill fills in when the DM picks it (page 9). */
export function skillAbility(skill: SkillKey): AbilityKey {
  return SKILLS[skill].ability;
}

/** The skills listed under one ability, as the request sheet groups them, in the table's order. */
export function skillsOf(ability: AbilityKey): SkillKey[] {
  return SKILL_KEYS.filter((skill) => SKILLS[skill].ability === ability);
}

/**
 * The Typical Difficulty Classes (page 6), for ability checks. A saving
 * throw's DC is the effect's (page 7), so the sheet offers these for checks
 * alone.
 */
export const TYPICAL_DCS: readonly { dc: number; name: string }[] = [
  { dc: 5, name: "Very easy" },
  { dc: 10, name: "Easy" },
  { dc: 15, name: "Medium" },
  { dc: 20, name: "Hard" },
  { dc: 25, name: "Very hard" },
  { dc: 30, name: "Nearly impossible" },
];

/** One choice as the test's words name it: "Strength (Athletics)", or "Dexterity". */
export function choiceText(choice: RollChoice): string {
  const ability = ABILITY_NAMES[choice.ability];
  return choice.skill === undefined ? ability : `${ability} (${SKILLS[choice.skill].name})`;
}

/**
 * The test as a sentence's object, with its article: "a Dexterity saving
 * throw", "a Strength or Dexterity saving throw", "a Strength (Athletics)
 * or Dexterity (Acrobatics) check", "a Wisdom (Perception) check". Two
 * choices with no skill share the noun, as the SRD writes "a Strength or
 * Dexterity saving throw (it chooses which)".
 */
export function testText(test: RollTest): string {
  const noun = test.kind === "save" ? "saving throw" : "check";
  const named = test.choices.map(choiceText).join(" or ");
  return `${/^[AEIOU]/.test(named) ? "an" : "a"} ${named} ${noun}`;
}

/** The short name a chip uses: "Dex save", "Str (Athletics) check", "Str or Dex save". */
export function testShortText(test: RollTest): string {
  const short = (choice: RollChoice) => {
    const ability = ABILITY_NAMES[choice.ability].slice(0, 3);
    return choice.skill === undefined ? ability : `${ability} (${SKILLS[choice.skill].name})`;
  };
  return `${test.choices.map(short).join(" or ")} ${test.kind === "save" ? "save" : "check"}`;
}
