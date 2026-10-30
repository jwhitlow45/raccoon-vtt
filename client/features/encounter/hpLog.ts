import type { Actor, LogEntry, LogEvent, RoomState } from "#shared/model.ts";
import { revertedActor, takenBack } from "#shared/reducer/hpUndo.ts";

/**
 * The combat log of HP changes (features section 10): every HP line of the
 * fight on screen, each with what was left after it, and for the DM a way
 * to take one back. The lines arrive projected (design 7.3), so a player
 * holds only lines about creatures they can see, with numbers only where
 * the HP display setting allows them. Kept free of React for plain tests.
 */

export type HpLine = { entry: LogEntry; data: Extract<LogEvent, { type: "hp" }> };

/**
 * The HP lines since the fight began, newest first. A fight that began
 * longer ago than the log the room holds shows the lines it does hold.
 */
export function fightHpLines(log: readonly LogEntry[]): HpLine[] {
  let start = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    const data = log[i]!.data;
    if (data?.type === "encounter" && data.action === "start") {
      start = i + 1;
      break;
    }
  }
  const out: HpLine[] = [];
  for (let i = log.length - 1; i >= start; i--) {
    const entry = log[i]!;
    if (entry.data?.type === "hp") out.push({ entry, data: entry.data });
  }
  return out;
}

type HolderView = Pick<RoomState, "tokens" | "characters">;

function currentActor(view: HolderView, data: HpLine["data"]): Actor | undefined {
  if (data.characterId !== undefined) return view.characters[data.characterId]?.actor;
  if (data.tokenId !== undefined) {
    const token = view.tokens[data.tokenId];
    return token && "inline" in token.actor ? token.actor.inline : undefined;
  }
  return undefined;
}

/**
 * Whether the DM may offer to take a line back. Only the DM's projection
 * carries what a change replaced. A line already taken back, or the record
 * of a take-back, has nothing to offer. When this view holds the creature,
 * the same check the server runs says whether it changed since, so the
 * button shows only where the undo would apply. A creature on another
 * scene is not in a DM's view, and the server decides.
 */
export function canTakeBack(view: HolderView, log: readonly LogEntry[], line: HpLine): boolean {
  if (!line.data.revert || line.data.back || takenBack(log, line.entry.id)) return false;
  const actor = currentActor(view, line.data);
  if (!actor) return true;
  return revertedActor(actor, line.data.revert) !== null;
}

/** Whether an HP event in the general log offers Undo. */
export function canUndoLogLine(view: HolderView, log: readonly LogEntry[], entry: LogEntry, retainedIds: readonly string[]): boolean {
  return retainedIds.includes(entry.id) && entry.data?.type === "hp" && canTakeBack(view, log, { entry, data: entry.data });
}
