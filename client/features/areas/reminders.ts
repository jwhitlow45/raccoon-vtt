import type { LogEntry, RoomState } from "#shared/model.ts";
import type { AreaEvent } from "#shared/logText.ts";

/**
 * How the reminders that an area hits a creature again read, and who gets
 * them as a toast as well as a log line (features section 9). The reducer
 * writes them (shared/reducer/areaTriggers.ts) and the projection has
 * already dropped any this viewer may not read. The words are the log's
 * (shared/logText.ts), so the toast and the log line read the same.
 */

export { areaReminderText, type AreaEvent } from "#shared/logText.ts";

/**
 * Who gets the toast: the DM, who runs the area's effect, and of the
 * players, the one whose creature must save and the one whose area it is,
 * who rolls its damage. Everyone else reads it in the log, so a fight with
 * Spirit Guardians does not fill every phone with notices.
 */
export function remindsYou(
  data: AreaEvent,
  you: { memberId: string; role: "dm" | "player" },
  view: Pick<RoomState, "tokens" | "characters" | "templates">,
): boolean {
  if (you.role === "dm") return true;
  if (view.templates[data.templateId]?.ownerId === you.memberId) return true;
  const token = view.tokens[data.tokenId];
  if (!token) return false;
  if (token.ownerIds?.includes(you.memberId)) return true;
  // Other players' projections of a token carry no owners, and a PC's owners are its character's.
  // Another player's character comes without its owners too, so that list may be missing as well.
  const ref = token.actor && "ref" in token.actor ? token.actor.ref : undefined;
  return (ref !== undefined && view.characters[ref]?.ownerIds?.includes(you.memberId)) ?? false;
}

function seqOf(entry: LogEntry): number {
  const n = Number(entry.id.split(":")[0]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The confirmed log entries that arrived since the last look. The first
 * look only learns what is there: the log a snapshot carries is history,
 * and the Log panel shows it. An entry still riding on a pending op is left
 * for later, so a prediction the server then changes never shows.
 */
export function arrivals(seen: ReadonlySet<string> | null, log: readonly LogEntry[], confirmedSeq: number): { seen: Set<string>; fresh: LogEntry[] } {
  const confirmed = log.filter((e) => seqOf(e) <= confirmedSeq);
  const next = new Set(confirmed.map((e) => e.id));
  if (!seen) return { seen: next, fresh: [] };
  return { seen: next, fresh: confirmed.filter((e) => !seen.has(e.id)) };
}
