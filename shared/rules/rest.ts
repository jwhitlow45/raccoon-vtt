import type { Actor, ClassResource, Effect } from "../model.ts";
import { effectEvent, hpLabel, withNewPool, type ActorEvent, type HpResult } from "./hp.ts";

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
 * - Spent abilities and class resources (docs/design-v1-combat-controls.md
 *   2.4): a Short Rest brings back recharges, the uses that come back on a
 *   rest, X a day uses that say a Short Rest does, a short resource whole
 *   and one of a "short, one" resource. A Long Rest brings back every mark
 *   and every resource, and clears the damage types taken.
 *
 * What the app does not track is left to the sheet: spent Hit Point Dice
 * and a reduced HP maximum, which the app keeps no separate normal value
 * for.
 */

export type RestKind = "short" | "long";

export type RestResult = HpResult | { refused: string };

export const REST_NEEDS_HP = "a rest needs at least 1 Hit Point";

export function applyRest(actor: Actor, kind: RestKind, heal = 0): RestResult {
  if (actor.life !== "alive" || actor.hp.cur < 1) return { refused: REST_NEEDS_HP };
  if (kind === "short") {
    const cur = Math.min(actor.hp.max, actor.hp.cur + Math.max(0, heal));
    const next: Actor = { ...restedUses(actor, kind), hp: { ...actor.hp, cur } };
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
  const next: Actor = { ...withNewPool(restedUses(actor, kind), 0), hp: { cur: actor.hp.max, max: actor.hp.max, temp: 0 }, deathSaves: { ok: 0, fail: 0 }, effects };
  if (actor.legendary) next.legendary = { ...actor.legendary, actionsUsed: 0, resistUsed: 0 };
  events.unshift({ type: "rest", kind, left: { ...next.hp }, label: hpLabel(next) });
  return { actor: next, events };
}

/**
 * The actor's spent abilities after a rest (docs/design-v1-combat-controls.md
 * 2.4): a Short Rest takes the recharge and rest marks and the X a day ones
 * a Short Rest brings back, a Long Rest every mark, `hurt` and its record's
 * `took`. The very same actor when nothing comes back.
 */
export function restedUses(actor: Actor, kind: RestKind): Actor {
  const marks = actor.uses ?? {};
  const back = (mark: NonNullable<Actor["uses"]>[string]) => kind === "long" || mark.kind === "recharge" || mark.kind === "rest" || (mark.kind === "day" && mark.short === true);
  const kept = Object.fromEntries(Object.entries(marks).filter(([, mark]) => !back(mark)));
  const took = kind === "long" && actor.turnRecord?.took !== undefined;
  if (Object.keys(kept).length === Object.keys(marks).length && !took && (kind === "short" || actor.hurt === undefined)) return actor;
  const next: Actor = { ...actor };
  if (Object.keys(kept).length > 0) next.uses = kept;
  else delete next.uses;
  if (kind === "long") delete next.hurt;
  if (took) {
    const { took: _took, ...record } = actor.turnRecord!;
    next.turnRecord = record;
  }
  return next;
}

/**
 * A character's class resources after a rest (7.1): a Long Rest gives all
 * back, a Short Rest a short one's all and a "short, one" resource's one.
 * The very same list when nothing comes back.
 */
export function restedResources(resources: readonly ClassResource[] | undefined, kind: RestKind): ClassResource[] | undefined {
  if (!resources) return undefined;
  let changed = false;
  const next = resources.map((r) => {
    const used = kind === "long" || r.reset === "short" ? 0 : r.reset === "shortOne" ? Math.max(0, r.used - 1) : r.used;
    if (used === r.used) return r;
    changed = true;
    return { ...r, used };
  });
  return changed ? next : (resources as ClassResource[]);
}
