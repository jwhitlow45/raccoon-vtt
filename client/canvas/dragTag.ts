import type { Member } from "#shared/model.ts";
import { markOwner } from "../features/pings/who.ts";
import { theme } from "../lib/theme.ts";

/**
 * The name tag over someone else's drag preview (features section 5): who
 * is moving the token, in their color, the way pings, the laser and rulers
 * name theirs. Every remote drag gets one, a drag from this member's other
 * device too, which is what the table sees.
 */
export function dragTag(from: string, members: Readonly<Record<string, Member | undefined>> | undefined): { text: string; color: string } {
  return { text: markOwner({ from, local: false }, members) ?? "Someone", color: members?.[from]?.color ?? theme.color.crest };
}
