import type { CritRule, RoomSettings } from "../model.ts";

/**
 * A critical hit's damage under the room's rule (docs/design-v1-dice.md,
 * the critical hit rules addendum). The server applies the rule when it
 * rolls, from the `critical` flag on a roll, so no client computes a
 * crit's formula or total.
 */

/** The room's rule. Absent, in rooms from before the setting, is the 2024 rule they always rolled by. */
export function critRuleOf(settings: Pick<RoomSettings, "critRule">): CritRule {
  return settings.critRule ?? "rollTwice";
}
