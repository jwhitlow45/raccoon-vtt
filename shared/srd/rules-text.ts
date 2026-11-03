import type { ConditionKey, StatusKey } from "../model.ts";
import data from "./rules-text.json" with { type: "json" };

/**
 * Rules text from SRD 5.2.1 (CC-BY-4.0, see NOTICE.md), generated into
 * rules-text.json by scripts/srd-import.ts. conditions.ts and statuses.ts
 * pair it with the app's own labels and summaries.
 *
 * `text` is Markdown limited to paragraphs, `**bold**` run-in headings,
 * `*italic*` lines, and `- ` lists, the same subset as the monster stat blocks
 * (see monsters.ts).
 */
export type RulesTextEntry = {
  /** The SRD's name for the rule, such as "Hide" or "Bless". */
  title: string;
  /** Where the SRD defines it, such as "Rules Glossary, action" or "Spell". */
  source: string;
  text: string;
};

/**
 * The rules weather's rolls rest on (docs/design/design-v1-weather.md 2): two
 * paragraphs of Environmental Effects, Obscured Areas, and the Weapons
 * table's ranged weapons and melee weapons with the Thrown property, each a
 * `- ` list of names.
 */
export const ENVIRONMENT_KEYS = ["obscured-areas", "heavy-precipitation", "strong-wind", "ranged-weapons", "thrown-weapons"] as const;
export type EnvironmentKey = (typeof ENVIRONMENT_KEYS)[number];

export type RulesText = {
  conditions: Record<ConditionKey, RulesTextEntry>;
  /** Only the statuses the SRD defines. */
  statuses: Partial<Record<StatusKey, RulesTextEntry>>;
  environment: Record<EnvironmentKey, RulesTextEntry>;
};

export const RULES_TEXT: RulesText = data;

/** The names a weapon list holds, as the Weapons table prints them: "Light Crossbow". */
export function weaponList(key: "ranged-weapons" | "thrown-weapons"): string[] {
  return RULES_TEXT.environment[key].text.split("\n").map((line) => line.replace(/^- /, "").replace(/\\(.)/g, "$1"));
}
