import { MEMBER_COLORS } from "../../lib/theme.ts";

/**
 * The disk colors on offer: the member palette, then four neutrals from
 * light gray to black. Any color passes the protocol, so a later palette
 * never breaks an icon already placed.
 *
 * Kept apart from icons.ts, which draws in the browser, so a Node script
 * can check the SRD monsters' default disks against the same swatches
 * (scripts/srd-token-icons.ts).
 */
export const ICON_NEUTRALS = ["#8b8a93", "#55545c", "#2a2a32", "#0b0b0e"] as const;
export const ICON_COLORS: readonly string[] = [...MEMBER_COLORS, ...ICON_NEUTRALS];
/** A dark neutral, so a new icon reads as a token whatever the disposition ring around it says. */
export const DEFAULT_ICON_COLOR = "#2a2a32";
