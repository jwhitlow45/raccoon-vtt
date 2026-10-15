import { useMemo } from "react";
import { accentFor, type Accent } from "../lib/accent.ts";
import { useRoomView } from "./view.ts";

/**
 * The viewing member's accent, resolved to plain colors (lib/accent.ts).
 * The board needs this rather than `theme.color.accent`, because a canvas
 * cannot read a CSS variable.
 */
export function useAccent(): Accent {
  const color = useRoomView((s) => (s.you ? s.view?.members[s.you.memberId]?.color : undefined));
  return useMemo(() => accentFor(color), [color]);
}
