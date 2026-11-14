import type { Effect } from "../model.ts";
import { hash128 } from "../project.ts";
import { ZERO_HP_UNCONSCIOUS_ID } from "./hp.ts";

/**
 * Conditions by class (docs/design/design-v1-player-limits.md 6.1): a
 * creature holds at most EFFECTS_PER_CLASS shown and as many hidden, and
 * the automatic Unconscious (shared/rules/hp.ts ZERO_HP_UNCONSCIOUS_ID)
 * outside both counts. A player's add reads the shown count alone, so it
 * answers the same whatever the DM hid.
 */
export const EFFECTS_PER_CLASS = 32;

/** The most conditions one creature stores: both classes full and the automatic Unconscious. */
export { EFFECTS_STORED_MOST } from "../protocol.ts";

/**
 * An automatic Unconscious that was hidden or edited becomes an ordinary
 * condition under this long form: the prefix and 64 hex characters of a
 * hash of its holder's key and its old id. No old effect id is longer
 * than 64 characters, so the form can never meet one, and the id gate
 * refuses it from every device since it is not version 7.
 */
export const CONVERTED_EFFECT_PREFIX = "auto-unconscious:";
export { CONVERTED_EFFECT_ID } from "../protocol.ts";

/**
 * The converted id of the effect `oldId` on the creature whose entity key
 * is `holder` (shared/keys.ts): a plain hash of the two, so it is the same
 * on every load and every device, and two creatures' conversions differ.
 * It reads nothing else, so nothing else the creature holds moves it.
 */
export function convertedEffectId(holder: string, oldId: string): string {
  return CONVERTED_EFFECT_PREFIX + hash128(`${holder}\n${oldId}`) + hash128(`${oldId}\n${holder}`);
}

/** Whether an effect is the automatic Unconscious as the HP rules add it: the key alone, shown, with no label, spell, duration or save. */
export function bareAutomatic(effect: Effect): boolean {
  if (effect.id !== ZERO_HP_UNCONSCIOUS_ID || effect.key !== "unconscious") return false;
  for (const [field, value] of Object.entries(effect)) {
    if (field === "id" || field === "key" || value === undefined) continue;
    if (field === "hiddenFromPlayers" && value === false) continue;
    return false;
  }
  return true;
}

/**
 * The list as every writer stores it: an effect that holds the automatic
 * id but is hidden or not bare goes on under its converted id, an ordinary
 * condition from then on, and an id held twice keeps its first. So no
 * hidden or edited automatic Unconscious, and no second one, is ever kept.
 */
export function normalEffects(holder: string, list: readonly Effect[]): Effect[] {
  let out: Effect[] | null = null;
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const effect = list[i]!;
    const id = effect.id === ZERO_HP_UNCONSCIOUS_ID && !bareAutomatic(effect) ? convertedEffectId(holder, effect.id) : effect.id;
    const changed = id !== effect.id || seen.has(id);
    if (changed && out === null) out = list.slice(0, i);
    if (!seen.has(id)) {
      seen.add(id);
      if (out !== null) out.push(id === effect.id ? effect : { ...effect, id });
    }
  }
  return out ?? [...list];
}

/** The class an effect counts in, or null for the bare automatic Unconscious, which counts in neither. */
export function effectClass(effect: Effect): "shown" | "hidden" | null {
  if (bareAutomatic(effect)) return null;
  return effect.hiddenFromPlayers ? "hidden" : "shown";
}

export type EffectsFit = { ok: true; effects: Effect[] } | { ok: false; full: "shown" | "hidden" };

/**
 * `adding` appended to `list` on the creature `holder`, normalized
 * (normalEffects), if each class it adds to stays within EFFECTS_PER_CLASS.
 * A class already past it from an older room refuses only more of its own.
 */
export function effectsFit(holder: string, list: readonly Effect[], adding: readonly Effect[]): EffectsFit {
  const effects = normalEffects(holder, [...list, ...adding]);
  const counts = { shown: 0, hidden: 0 };
  for (const effect of effects) {
    const c = effectClass(effect);
    if (c !== null) counts[c]++;
  }
  for (const effect of adding) {
    const c = effectClass(effect);
    if (c !== null && counts[c] > EFFECTS_PER_CLASS) return { ok: false, full: c };
  }
  return { ok: true, effects };
}

/**
 * `list` with the effect at `index` replaced by `next` in place,
 * normalized, if the class `next` counts in stays within
 * EFFECTS_PER_CLASS. Only a change of class can pass one, so an edit
 * that keeps its class always fits.
 */
export function effectsFitChanged(holder: string, list: readonly Effect[], index: number, next: Effect): EffectsFit {
  const was = list[index];
  const changed = [...list];
  changed[index] = next;
  const effects = normalEffects(holder, changed);
  const c = effectClass(next);
  if (c === null || (was !== undefined && effectClass(was) === c)) return { ok: true, effects };
  const count = effects.filter((e) => effectClass(e) === c).length;
  return count > EFFECTS_PER_CLASS ? { ok: false, full: c } : { ok: true, effects };
}

/** `adding` put into `list` at `index`, normalized, if its class stays within EFFECTS_PER_CLASS: Previous puts an ended condition back where it was. */
export function effectsFitAt(holder: string, list: readonly Effect[], index: number, adding: Effect): EffectsFit {
  const effects = normalEffects(holder, [...list.slice(0, index), adding, ...list.slice(index)]);
  const c = effectClass(adding);
  if (c === null) return { ok: true, effects };
  return effects.filter((e) => effectClass(e) === c).length > EFFECTS_PER_CLASS ? { ok: false, full: c } : { ok: true, effects };
}

/** `list` normalized, if every class stays within EFFECTS_PER_CLASS: a log undo puts back a whole list. */
export function effectsWithin(holder: string, list: readonly Effect[]): EffectsFit {
  const effects = normalEffects(holder, list);
  for (const c of ["shown", "hidden"] as const) {
    if (effects.filter((e) => effectClass(e) === c).length > EFFECTS_PER_CLASS) return { ok: false, full: c };
  }
  return { ok: true, effects };
}
