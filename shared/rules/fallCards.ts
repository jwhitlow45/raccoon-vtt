import type { Fall, FallId } from "../model.ts";

/*
 * The order of fall cards (docs/design/design-v1-floors.md phase 4, 4.4),
 * read alike by the reducer's eviction and the DM's desk and toasts, so
 * the card a device shows first is the one the room keeps longest.
 */

/** A card's place among the cards of the op it was made in: the part of its id after the seq, "120:1" is 1. */
export function fallPlace(id: FallId): number {
  return Number(id.slice(id.indexOf(":") + 1));
}

/** Oldest first: by the op each was made in, then its place among that op's cards. */
export function byFallAge(a: Pick<Fall, "id" | "made">, b: Pick<Fall, "id" | "made">): number {
  return a.made - b.made || fallPlace(a.id) - fallPlace(b.id);
}
