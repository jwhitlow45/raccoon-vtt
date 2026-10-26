import type { Member } from "#shared/model.ts";
import type { PillProps } from "../features/measure/pillPlace.ts";
import { markOwner } from "../features/pings/who.ts";
import { footprint, type ViewToken } from "../lib/scene.ts";
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

/**
 * The tag's pill as Top-down draws it over a ghost at `at`: small, sized
 * with the map, over the middle of the token's top edge, its pointer down
 * to it. The isometric view's stand rule judges the tag by this same box.
 */
export function dragTagPill(token: Pick<ViewToken, "size" | "w" | "h">, at: { x: number; y: number }, name: string, scale: number): Omit<PillProps, "color"> {
  return { x: at.x + footprint(token).w / 2, y: at.y - 4 / scale, scale, name, size: "map", small: true, above: true };
}
