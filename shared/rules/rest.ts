import type { Actor, Effect } from "../model.ts";
import { effectEvent, hpLabel, type ActorEvent, type HpResult } from "./hp.ts";

/**
 * Short and long rests (features section 15), as SRD 5.2.1 states them in
 * its Rules Glossary ("Short Rest", "Long Rest", "Temporary Hit Points",
 * and "X/Day" in the monster rules).
 *
 * - Either rest needs at least 1 Hit Point to start.
 * - Short Rest: the creature may spend Hit Point Dice, rolling each and
 *   adding its Constitution modifier, at least 1 HP a die. The app rolls no
 *   dice and tracks no Hit Point Dice, so the player rolls and the rest
 *   takes the total they got (`heal`).
 * - Long Rest: all lost HP back. Temporary HP last only until a Long Rest
 *   ends, so they go. Exhaustion drops one level, and the condition ends
 *   at 0. "X/Day" uses come back after a Long Rest, so Legendary Resistance
 *   resets, and legendary actions with it.
 *
 * What the app does not track is left to the sheet: spent Hit Point Dice,
 * class features that recharge, and a reduced HP maximum, which the app
 * keeps no separate normal value for.
 */

export type RestKind = "short" | "long";

export type RestResult = HpResult | { refused: string };

export const REST_NEEDS_HP = "a rest needs at least 1 Hit Point";

export function applyRest(actor: Actor, kind: RestKind, heal = 0): RestResult {
  if (actor.life !== "alive" || actor.hp.cur < 1) return { refused: REST_NEEDS_HP };
  if (kind === "short") {
    const cur = Math.min(actor.hp.max, actor.hp.cur + Math.max(0, heal));
    const next: Actor = { ...actor, hp: { ...actor.hp, cur } };
    return { actor: next, events: [{ type: "rest", kind, amount: cur - actor.hp.cur, left: { ...next.hp }, label: hpLabel(next) }] };
  }
  const events: ActorEvent[] = [];
  const effects: Effect[] = [];
  let lowered = false;
  for (const effect of actor.effects) {
    if (effect.key !== "exhaustion" || lowered) {
      effects.push(effect);
      continue;
    }
    lowered = true;
    const level = (effect.level ?? 1) - 1;
    if (level >= 1) effects.push({ ...effect, level });
    else events.push(effectEvent(effect, "remove"));
  }
  const next: Actor = { ...actor, hp: { cur: actor.hp.max, max: actor.hp.max, temp: 0 }, deathSaves: { ok: 0, fail: 0 }, effects };
  if (actor.legendary) next.legendary = { ...actor.legendary, actionsUsed: 0, resistUsed: 0 };
  events.unshift({ type: "rest", kind, left: { ...next.hp }, label: hpLabel(next) });
  return { actor: next, events };
}
