import type { Effect, InitEntry, RoomState } from "#shared/model.ts";
import { MAX_NAME, type ActorTarget, type ClientOp } from "#shared/protocol.ts";
import { entryIsSelf, type SelfRef } from "../tokens/durations.ts";
import type { TrackerView } from "./logic.ts";

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

/** The creature's own initiative row, which its Reaction belongs to, or undefined outside the fight. */
export function selfEntryId(view: Pick<RoomState, "tokens" | "characters" | "encounter"> | null | undefined, self: SelfRef): string | undefined {
  if (!view?.encounter) return undefined;
  return view.encounter.entries.find((e) => entryIsSelf(view, e, self))?.id;
}

/** Marks the row's creature as holding a Ready action until the start of its next turn. */
export function readyOp(input: { target: ActorTarget; entryId: string; trigger: string; id: string }): ClientOp {
  const trigger = input.trigger.trim().slice(0, MAX_TRIGGER);
  const effect = { id: input.id, key: "readied" as const, duration: { mode: "turnStart" as const, of: { entryId: input.entryId } } };
  return { t: "actor.effect.add", target: input.target, effect: trigger ? { ...effect, label: trigger } : effect };
}

/**
 * The trigger happened and the creature acted: the marker goes, and its
 * Reaction is spent until its turn starts. One gesture, so the DM's undo
 * takes both back together.
 */
export function fireOps(input: { target: ActorTarget; effectId: string; entryId: string }): ClientOp[] {
  return [
    { t: "actor.effect.remove", target: input.target, effectId: input.effectId },
    { t: "encounter.update", entryId: input.entryId, patch: { reactionUsed: true } },
  ];
}
