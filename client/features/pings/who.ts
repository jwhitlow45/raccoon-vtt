import type { Member } from "#shared/model.ts";

/**
 * The name shown beside someone else's ping, laser or ruler (UP-21), so a
 * table of five can tell who pointed. This device's own marks carry none:
 * the person who made them knows.
 */
export function markOwner(mark: { from: string; local: boolean }, members: Readonly<Record<string, Member | undefined>> | undefined): string | null {
  if (mark.local) return null;
  return members?.[mark.from]?.name ?? "Someone";
}
