/**
 * The Armor Class shield (docs/design-v1-token-panel.md 3.9), as plain
 * functions for node --test: the shield's outline and the box a badge
 * takes for a number. The map, the token bar, the token panel, the tracker
 * and the party bar all draw this one shape, so AC reads the same
 * everywhere it shows.
 */

/** The shield outline, in a 24 px box: the D&D sign for AC, first drawn by the party bar. */
export const SHIELD_PATH = "M12 2 4 5v6c0 5.2 3.4 9.8 8 11 4.6-1.2 8-5.8 8-11V5z";

/**
 * The outline's own bounds in that box (x 4 to 20, y 2 to 22) with half a
 * unit to spare. A badge stretches these to its box, so the outline fills
 * it, its 1 px line is not cut at the edges, and a wider box for three
 * digits widens the shield around them, on the map as in the page.
 */
export const SHIELD_BOUNDS = { x: 3.5, y: 1.5, width: 17, height: 21 } as const;

/** `md` for the bar and the panel, `sm` for dense rows such as the tracker's and the party bar's. */
export type AcBadgeSize = "sm" | "md";

const SIZES: Record<AcBadgeSize, { height: number; min: number; pad: number; textPx: number }> = {
  md: { height: 22, min: 20, pad: 8, textPx: 13 },
  sm: { height: 18, min: 16, pad: 6, textPx: 11 },
};

/** A bold number's width in the interface font: its digits are tabular, about 0.6 of the size each, which gives the widths the token panel design sets: 20, 24 and 32 px at md for 9, 99 and 100. */
export function numberWidth(text: string, px: number): number {
  return text.length * px * 0.6;
}

export type AcBadgeBox = { width: number; height: number; textPx: number };

/**
 * The badge's box for an AC: a fixed height, and wide enough for its
 * digits, so 9, 99 and 100 each fit inside the shield. Nothing for an AC
 * of 0, which a companion with none has (docs/design-v1-combat-flow.md
 * 3.6.6), or for anything outside the 1 to 100 the protocol allows.
 */
export function acBadgeBox(ac: number, size: AcBadgeSize): AcBadgeBox | null {
  if (!Number.isInteger(ac) || ac < 1 || ac > 100) return null;
  const s = SIZES[size];
  return { width: Math.max(s.min, Math.ceil(numberWidth(String(ac), s.textPx) + s.pad)), height: s.height, textPx: s.textPx };
}
