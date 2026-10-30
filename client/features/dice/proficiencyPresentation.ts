import type { D20Test } from "#shared/dice/bonus.ts";
import { ABILITY_KEYS, SKILL_KEYS, type DiceRoll } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { ABILITY_NAMES, SKILLS } from "#shared/rules/skills.ts";

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
