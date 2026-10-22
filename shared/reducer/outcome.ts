import type { OpOf } from "../protocol.ts";
import { actorHp, effectAdd, effectRemove } from "./actors.ts";
import { ASK_CLOSED } from "../permissions.ts";
import { closeCast } from "./casts.ts";
import { settleTrap } from "./traps.ts";
import { Refuse, invalid, type Tx } from "./tx.ts";

/** The refusal of a Legendary Resistance a creature has no use of left. */
export const NO_RESISTANCE_LEFT = "it has no Legendary Resistance left";

/**
 * A group save's outcome (docs/design-v1-roll-options.md 5.5 and 8), as one
 * op the server applies whole or not at all, so one undo takes it all back
 * and nothing is ever half applied. Each creature in its order: the
 * Legendary Resistance it spends, the effects it loses (a save-ends effect a
 * resisted save ends), its damage by `actor.hp`'s rules, concentration
 * prompts included, then the conditions it gains as `actor.effects` adds
 * them. Any refusal refuses the whole. An outcome that resolves a player's
 * ask for saves closes it first (docs/design-v1-player-save-spell.md 5.3),
 * so two DM devices that opened one ask apply it once.
 */
export function actorOutcome(tx: Tx, op: OpOf<"actor.outcome">): void {
  if (op.cast !== undefined) {
    const ask = tx.state.casts[op.cast];
    if (!ask) throw new Refuse("gone", ASK_CLOSED);
    closeCast(tx, ask, "done");
  }
  // A trap's group save settles its occurrence in the same op, so a trap applies at most once (docs/design-v1-traps.md 6.2).
  if (op.trap !== undefined) settleTrap(tx, op.trap.trapId, op.trap.due);
  const holders = new Set<string>();
  for (const item of op.targets) {
    const resolved = tx.resolveActor(item.target);
    const holder = `${resolved.holder}:${resolved.id}`;
    if (holders.has(holder)) throw invalid("a creature is listed twice");
    holders.add(holder);
    if (item.resist) {
      const legendary = resolved.actor.legendary;
      if (!legendary || legendary.resistUsed >= legendary.resistMax) throw invalid(NO_RESISTANCE_LEFT);
      tx.putActor(resolved, { ...resolved.actor, legendary: { ...legendary, resistUsed: legendary.resistUsed + 1 } });
    }
    for (const effectId of item.remove ?? []) effectRemove(tx, { t: "actor.effect.remove", target: item.target, effectId });
    if (item.amount !== undefined) actorHp(tx, { t: "actor.hp", target: item.target, change: { kind: "damage", amount: item.amount } });
    for (const effect of item.effects ?? []) effectAdd(tx, { t: "actor.effect.add", target: item.target, effect });
  }
}
