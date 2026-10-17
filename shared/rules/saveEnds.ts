import { compareLogIds } from "../keys.ts";
import type { Effect, RollRequest, RoomState } from "../model.ts";
import type { ActorTarget } from "../protocol.ts";

/**
 * The save-ends occurrences still waiting (docs/design-v1-roll-options.md
 * 6.1), one card each in the DM's fight alerts. They are read from the
 * effects alone, so a reload brings back exactly the unsettled ones, and a
 * request linked to one is named beside it.
 */
export type PendingSave = {
  target: ActorTarget;
  effect: Effect & { save: NonNullable<Effect["save"]>; due: NonNullable<Effect["due"]> };
  /** The open request that asks it, if one was sent. */
  request?: RollRequest;
};

export function pendingSaves(state: Pick<RoomState, "tokens" | "characters" | "rolls">): PendingSave[] {
  const asked = new Map<string, RollRequest>();
  for (const request of Object.values(state.rolls)) if (request.ends) asked.set(request.ends.occurrence, request);
  const out: PendingSave[] = [];
  const add = (target: ActorTarget, effects: readonly Effect[]) => {
    for (const effect of effects) {
      if (!effect.save || effect.due?.state !== "pending") continue;
      const request = asked.get(effect.due.id);
      out.push({ target, effect: effect as PendingSave["effect"], ...(request ? { request } : {}) });
    }
  };
  for (const character of Object.values(state.characters)) add({ characterId: character.id }, character.actor.effects);
  for (const token of Object.values(state.tokens)) if ("inline" in token.actor) add({ tokenId: token.id }, token.actor.inline.effects);
  // Oldest turn end first, so the cards keep their order across a reload.
  return out.sort((a, b) => compareLogIds(a.effect.due.id, b.effect.due.id));
}
