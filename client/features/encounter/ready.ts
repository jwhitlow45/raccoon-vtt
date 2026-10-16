import type { Effect, InitEntry, RoomState } from "#shared/model.ts";
import { MAX_NAME, type ActorTarget, type ClientOp } from "#shared/protocol.ts";
import { entryIsSelf, type SelfRef } from "../tokens/durations.ts";
import { rowCharacter } from "#shared/rules/initiative.ts";
import { sortedEntries, type TrackerView } from "./logic.ts";

/**
 * Hold and Ready markers (features section 10). In the 2024 rules a
 * creature takes the Ready action on its turn, names a trigger, and acts
 * with its Reaction when the trigger happens before its next turn starts
 * (SRD 5.2.1, "Ready"). The app keeps that as the `readied` status, so it
 * shows on the token and the row like any other, with the trigger as its
 * label. It runs until the start of the creature's next turn, which the
 * shared duration rules already count (design 9.5), so the marker clears
 * itself there, and Previous puts it back.
 */

/** The longest trigger the effect's label holds. */
export const MAX_TRIGGER = MAX_NAME;

export function readiedEffect(effects: readonly Effect[] | undefined): Effect | undefined {
  return effects?.find((e) => e.key === "readied");
}

/**
 * The creature behind a row, as effect ops name it. A token that points at
 * a character is named by the token: the reducer follows it to the
 * character, and a player's view may hold the token without the character.
 */
export function rowTarget(view: TrackerView, entry: Pick<InitEntry, "tokenId" | "characterId">): ActorTarget | null {
  if (entry.tokenId !== undefined) return view.tokens[entry.tokenId] ? { tokenId: entry.tokenId } : null;
  if (entry.characterId !== undefined) return view.characters[entry.characterId] ? { characterId: entry.characterId } : null;
  return null;
}

/**
 * Whose Reaction a creature spends and which row its Ready counts
 * (docs/design-v1-combat-flow.md 3.6.8): its own row, or for a companion
 * listed under its character, the companion's own Reaction on its token
 * and its character's row, since it acts on that turn. Null outside the
 * fight, for a creature with no row, and for a companion that is not
 * listed, which has no Reaction controls.
 */
export type ReactionTarget = { kind: "row"; entryId: string; tokenId?: string } | { kind: "companion"; tokenId: string; entryId: string };

export function reactionTarget(view: Pick<RoomState, "tokens" | "characters" | "encounter"> | null | undefined, self: SelfRef): ReactionTarget | null {
  const encounter = view?.encounter;
  if (!view || !encounter) return null;
  const companion = "tokenId" in self ? view.tokens[self.tokenId]?.companion : undefined;
  if (companion && companion.turn !== "own" && "tokenId" in self) {
    if (companion.turn === "none") return null;
    const row = sortedEntries(encounter.entries).find((e) => rowCharacter(view, e) === companion.of);
    return row ? { kind: "companion", tokenId: self.tokenId, entryId: row.id } : null;
  }
  const row = encounter.entries.find((e) => entryIsSelf(view, e, self));
  if (!row) return null;
  return row.tokenId !== undefined ? { kind: "row", entryId: row.id, tokenId: row.tokenId } : { kind: "row", entryId: row.id };
}

/** Marks the creature as holding a Ready action until the start of its next turn, which is its row's or its character's. */
export function readyOp(input: { target: ActorTarget; answer: ReactionTarget; trigger: string; id: string }): ClientOp {
  const trigger = input.trigger.trim().slice(0, MAX_TRIGGER);
  const effect = { id: input.id, key: "readied" as const, duration: { mode: "turnStart" as const, of: { entryId: input.answer.entryId } } };
  return { t: "actor.effect.add", target: input.target, effect: trigger ? { ...effect, label: trigger } : effect };
}

/**
 * The trigger happened and the creature acted: the marker goes, and the
 * Reaction the answer names is spent until its turn starts. A companion's
 * is its own, on its token, never its character's. One gesture, so the
 * DM's undo takes both back together.
 */
export function fireOps(input: { target: ActorTarget; effectId: string; answer: ReactionTarget }): ClientOp[] {
  const spend: ClientOp =
    input.answer.kind === "companion"
      ? { t: "token.update", tokenId: input.answer.tokenId, patch: { companionReaction: true } }
      : { t: "encounter.update", entryId: input.answer.entryId, patch: { reactionUsed: true } };
  return [{ t: "actor.effect.remove", target: input.target, effectId: input.effectId }, spend];
}
