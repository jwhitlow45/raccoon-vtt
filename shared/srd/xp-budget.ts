import data from "./xp-budget.json" with { type: "json" };

/**
 * The XP Budget per Character table from SRD 5.2.1's "Combat Encounter
 * Difficulty" (CC-BY-4.0, see NOTICE.md), generated into xp-budget.json by
 * scripts/srd-import.ts. One row per character level, 1 to 20: how much
 * monster XP one character of that level adds to the budget of a Low,
 * Moderate or High difficulty encounter.
 */
export type XpBudgetRow = { level: number; low: number; moderate: number; high: number };

export type Difficulty = "low" | "moderate" | "high";

export const DIFFICULTIES: readonly Difficulty[] = ["low", "moderate", "high"];

export const XP_BUDGET = data as readonly XpBudgetRow[];

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 20;
