import type { D20Test } from "#shared/dice/bonus.ts";
import { labelText } from "#shared/logText.ts";
import { ABILITY_KEYS, SKILL_KEYS, type DiceRoll, type RollTest } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import type { Proficiency } from "#shared/rules/proficiency.ts";
import { ABILITY_ABBR, ABILITY_NAMES, choiceText, SKILLS } from "#shared/rules/skills.ts";

export function rollTarget(ref: { tokenId?: string; characterId?: string }): ActorTarget | null {
  return ref.tokenId !== undefined ? { tokenId: ref.tokenId } : ref.characterId !== undefined ? { characterId: ref.characterId } : null;
}

/** Old dice events store labels, so recognize only the app's exact test names. */
export function rollTest(roll: Pick<DiceRoll, "label" | "save">): D20Test | null {
  if (roll.save) return { kind: "save", ability: roll.save };
  if (roll.label === "Concentration save") return { kind: "save", ability: "con", cause: "concentration" };
  for (const ability of ABILITY_KEYS) if (roll.label === `${ABILITY_NAMES[ability]} save`) return { kind: "save", ability };
  for (const skill of SKILL_KEYS) if (roll.label === `${SKILLS[skill].name} check`) return { kind: "check", ability: SKILLS[skill].ability, skill };
  return null;
}

/** "DEX save" or "Perception check", as a folded line names an ask (options.ts groupAsks), or null for a plain check, which takes no mark. */
export function askedTest(words: string): D20Test | null {
  for (const ability of ABILITY_KEYS) if (words === `${ABILITY_ABBR[ability]} save`) return { kind: "save", ability };
  return rollTest({ label: words });
}

/** Only a save or a skill check is marked. A plain ability check never is. */
export function marksTest(test: D20Test | null): test is D20Test {
  return test !== null && (test.kind === "save" || (test.kind === "check" && test.skill !== undefined));
}

/**
 * The words that name each shown choice of a request's test that takes a
 * mark, in order: testText's ("a Dexterity saving throw", "a Strength or
 * Dexterity saving throw", "a Wisdom (Perception) check") or, `short`,
 * testShortText's ("DEX save", "STR or DEX save", "WIS (Perception)
 * check"). A lone save's name takes its noun. A plain check takes no mark.
 */
export function choiceLabels(test: RollTest, shown: readonly number[], short = false): { index: number; label: string }[] {
  const save = test.kind === "save";
  return shown.flatMap((index) => {
    const choice = test.choices[index];
    if (!choice || (!save && choice.skill === undefined)) return [];
    const abbr = ABILITY_ABBR[choice.ability];
    const words = !short ? choiceText(choice) : choice.skill === undefined ? abbr : `${abbr} (${SKILLS[choice.skill].name})`;
    return [{ index, label: save && shown.length === 1 ? `${words} ${short ? "save" : "saving throw"}` : words }];
  });
}

export type TextMark = { at: number; length: number; level: Proficiency };

/**
 * Where each label stands in a line. Each is looked for after the one
 * before it, from `from`, so two alternatives that name the same skill
 * under different abilities, or a bare ability before the same ability
 * with a skill, each mark their own words and never the same ones twice
 * (FL7-SOL-01, FL7-R1-18). `from` steps past a name at the line's start,
 * and `after` asks for the words that lead into the label, so a name that
 * holds the same words is never marked. A label the line lacks marks
 * nothing.
 */
export function findMarks(text: string, labels: readonly { label: string; level: Proficiency; after?: string }[], from = 0): TextMark[] {
  const out: TextMark[] = [];
  let next = from;
  for (const { label, level, after = "" } of labels) {
    const found = label ? text.indexOf(after + label, next) : -1;
    if (found < 0) continue;
    const at = found + after.length;
    out.push({ at, length: label.length, level });
    next = at + label.length;
  }
  return out;
}

/**
 * Where a roll toast names its test: "Pat rolled 19 for Thorn, Perception
 * check.", "Rolled 19: Perception check.", "Pat rolled 3 Dexterity saves."
 * Each form ends with the label, after any creature's name. Several rolls
 * are marked only when they share the creature as well as the label, since
 * a line for several creatures stays neutral (D-261029-415). The words
 * themselves never change.
 */
export function toastMarks(text: string, rolls: readonly DiceRoll[], levelOf: (creature: ActorTarget, test: D20Test) => Proficiency): TextMark[] {
  const first = rolls[0];
  const target = first ? rollTarget(first) : null;
  const test = first ? rollTest(first) : null;
  if (!first || !target || first.label === undefined || !marksTest(test)) return [];
  if (rolls.some((roll) => roll.label !== first.label || roll.tokenId !== first.tokenId || roll.characterId !== first.characterId)) return [];
  const label = labelText(first.label);
  const at = text.lastIndexOf(label);
  return at < 0 ? [] : [{ at, length: label.length, level: levelOf(target, test) }];
}
