import { CONDITION_KEYS, type ConditionKey } from "../model.ts";
import { RULES_TEXT, type RulesTextEntry } from "./rules-text.ts";

/**
 * The 15 conditions with their 2024 rules text from SRD 5.2.1. The summaries
 * are this app's own short paraphrases for chips and lists. The full text in
 * `rules` is the SRD's, shown when a condition is tapped.
 */
export type ConditionInfo = {
  key: ConditionKey;
  name: string;
  summary: string;
  rules: RulesTextEntry;
};

const SUMMARIES: Record<ConditionKey, string> = {
  blinded: "Can’t see. Attack rolls against it have Advantage, and its attack rolls have Disadvantage.",
  charmed: "Can’t attack or harm the charmer. The charmer has Advantage on social checks against it.",
  deafened: "Can’t hear, and fails any ability check that needs hearing.",
  exhaustion: "Each level takes 2 off every D20 Test and 5 feet off Speed. Level 6 is death. A Long Rest removes 1 level.",
  frightened: "Disadvantage on ability checks and attack rolls while the source of fear is in sight. Can’t move closer to it.",
  grappled: "Speed 0. Disadvantage on attacks against anyone but the grappler, who can drag it along.",
  incapacitated: "No actions, Bonus Actions, Reactions or speech, and Concentration breaks. Disadvantage on Initiative.",
  invisible: "Can’t be seen. Attacks against it have Disadvantage and its attacks have Advantage, unless the other side can see it. Advantage on Initiative.",
  paralyzed: "Incapacitated with Speed 0. Fails Strength and Dexterity saves. Attacks against it have Advantage, and hits from within 5 feet are Critical Hits.",
  petrified: "Turned to stone: Incapacitated, Speed 0, Resistance to all damage. Fails Strength and Dexterity saves, and attacks against it have Advantage.",
  poisoned: "Disadvantage on attack rolls and ability checks.",
  prone: "Can only crawl, or spend half its Speed to stand up. Disadvantage on its attacks. Attacks from within 5 feet have Advantage, others Disadvantage.",
  restrained: "Speed 0. Attacks against it have Advantage and its attacks have Disadvantage. Disadvantage on Dexterity saves.",
  stunned: "Incapacitated. Fails Strength and Dexterity saves, and attacks against it have Advantage.",
  unconscious: "Incapacitated and Prone, and drops what it holds. Fails Strength and Dexterity saves. Attacks against it have Advantage, and hits from within 5 feet are Critical Hits.",
};

export const CONDITIONS = Object.fromEntries(
  CONDITION_KEYS.map((key) => {
    const rules = RULES_TEXT.conditions[key];
    return [key, { key, name: rules.title, summary: SUMMARIES[key], rules }];
  }),
) as Record<ConditionKey, ConditionInfo>;

/** Level 6 Exhaustion is death, so no creature goes past it. */
export const EXHAUSTION_MAX_LEVEL = 6;

/**
 * Whether an effect's level suits it: Exhaustion's is the condition's own
 * level, 1 to 6, since a Long Rest ends it at 0 and level 6 is death. Any
 * other effect's level is a counter, which the protocol bounds. Undefined
 * (no level) suits any effect, and so does a change that leaves it alone.
 */
export function levelFits(key: string, level: number | null | undefined): boolean {
  if (key !== "exhaustion" || level === undefined) return true;
  return level !== null && level >= 1 && level <= EXHAUSTION_MAX_LEVEL;
}

/**
 * An effect with its Exhaustion level brought within 1 to 6. Rooms from
 * before the rule may hold any counter there, and their backups must still
 * import.
 */
export function withLevelInRange<T extends { key: string; level?: number }>(effect: T): T {
  if (levelFits(effect.key, effect.level)) return effect;
  return { ...effect, level: Math.min(EXHAUSTION_MAX_LEVEL, Math.max(1, effect.level ?? 1)) };
}

/**
 * What a level of Exhaustion does under the 2024 rules: every D20 Test drops
 * by 2 per level and Speed by 5 feet per level, and level 6 kills. Levels
 * outside 0 to 6 are clamped, so a stray counter cannot produce a bonus.
 */
export function exhaustionEffects(level: number): { level: number; d20Modifier: number; speedModifier: number; dead: boolean } {
  const l = Math.max(0, Math.min(EXHAUSTION_MAX_LEVEL, Math.floor(level) || 0));
  // `0 - x` rather than `-x`, so level 0 gives 0 and not -0.
  return { level: l, d20Modifier: 0 - 2 * l, speedModifier: 0 - 5 * l, dead: l >= EXHAUSTION_MAX_LEVEL };
}
