import { useMemo } from "react";
import { accentFor, type Accent } from "../lib/accent.ts";
import { useScheme } from "../lib/scheme.ts";
import { useRoomView } from "./view.ts";

/** The viewing member's own color, or undefined outside a room or before the view arrives. */
function useMemberColor(): string | undefined {
  return useRoomView((s) => (s.you ? s.view?.members[s.you.memberId]?.color : undefined));
}

/**
 * The viewing member's accent resolved for dark, as plain colors
 * (lib/accent.ts). The board needs this rather than `theme.color.accent`,
 * because a canvas cannot read a CSS variable, and the board keeps the
 * dark look whatever the device's theme
 * (docs/design/design-v1-light-theme.md 6.4).
 */
export function useAccent(): Accent {
  const color = useMemberColor();
  return useMemo(() => accentFor(color, "dark"), [color]);
}

/**
 * The viewing member's accent for the page's own scheme, which the DOM's
 * accent variables carry (pages/RoomChrome.tsx useAccentVars). On a light
 * page the crest yellow becomes a dark olive gold, so it still reads.
 */
export function useSchemeAccent(): Accent {
  const color = useMemberColor();
  const scheme = useScheme();
  return useMemo(() => accentFor(color, scheme), [color, scheme]);
}
