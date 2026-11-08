import { clockNow, lineDate } from "#shared/calendar.ts";
import type { Encounter, RoomClock } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { HOUR_SECONDS } from "./words.ts";

/**
 * The ops of the DM's Long Rest for the party (docs/design/design-v1-calendar.md
 * 4.5), sent as one gesture. The advance comes first so each rest's stamp
 * marks the rest's end. There is no op of its own for the party: a refused
 * advance leaves the rests going through at the old time.
 */
export function partyRestOps(characterIds: readonly string[], moveClock: boolean, claim: string): ClientOp[] {
  const rests = characterIds.map((characterId): ClientOp => ({ t: "actor.rest", target: { characterId }, kind: "long" }));
  return moveClock ? [{ t: "clock.advance", by: 8 * HOUR_SECONDS, why: "longRest", claim }, ...rests] : rests;
}

/** The journal block "Add the date" appends: the clock's date and time now, as a heading. */
export function dateHeading(clock: RoomClock, encounter: Pick<Encounter, "round" | "activeEntryId" | "started"> | null | undefined): string {
  return `### ${lineDate(clockNow(clock, encounter), clock.calendar)}`;
}
