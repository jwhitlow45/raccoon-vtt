import type { Effect } from "../model.ts";

/**
 * Conditions by class (docs/design/design-v1-player-limits.md 6.1): a
 * creature holds at most EFFECTS_PER_CLASS shown and as many hidden, and
 * the automatic Unconscious (shared/rules/hp.ts ZERO_HP_UNCONSCIOUS_ID)
 * outside both counts. A player's add reads the shown count alone, so it
 * answers the same whatever the DM hid.
 */
export const EFFECTS_PER_CLASS = 32;

/**
 * An automatic Unconscious that was hidden or edited becomes an ordinary
 * condition under this long form: the prefix and 64 hex characters of a
 * hash of its holder's key and its old id. No old effect id is longer
 * than 64 characters, so the form can never meet one, and the id gate
 * refuses it from every device since it is not version 7.
 */
export const CONVERTED_EFFECT_PREFIX = "auto-unconscious:";
export const CONVERTED_EFFECT_ID = /^auto-unconscious:[0-9a-f]{64}$/;

/** The converted id of the effect `oldId` on the creature whose entity key is `holder` (shared/keys.ts): the same on every load and every device. */
export function convertedEffectId(holder: string, oldId: string): string {
  void holder;
  void oldId;
  throw new Error("convertedEffectId lands after the contract");
}

export type EffectsFit = { ok: true; effects: Effect[] } | { ok: false; full: "shown" | "hidden" };

/**
 * `adding` appended to `list` on the creature `holder`, if each class
 * stays within EFFECTS_PER_CLASS. Every writer of an effect list calls it,
 * so an automatic Unconscious that is hidden or not bare comes back under
 * its converted id, and a second automatic one is never kept.
 */
export function effectsFit(holder: string, list: readonly Effect[], adding: readonly Effect[]): EffectsFit {
  void holder;
  void list;
  void adding;
  throw new Error("effectsFit lands after the contract");
}
