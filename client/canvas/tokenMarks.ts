import type { Actor, Effect, TokenKind } from "#shared/model.ts";
import { hpLess } from "#shared/rules/hp.ts";
import { chipFit, type BoardSizes } from "../lib/boardScale.ts";
import type { Box } from "../lib/boardText.ts";
import { badgeLeft, chipRow, effectChip, effectCount, elevationBadge, type HpLabel } from "../lib/tokenView.ts";

/**
 * Where a token's marks go, in screen pixels from its top-left corner, at
 * the board's sizes for the zoom (lib/boardScale.ts): the chip row along
 * the top edge, the elevation badge at the top right, and the HP bar under
 * the bottom edge. The canvas draws them from this, and label placement
 * keeps off the same boxes, so the two always agree.
 *
 * A row whose chips hold text (a custom glyph, a counter, a "+N") grows its
 * chips to fit that text at the floor size. A row of icons alone may shrink
 * further, to 12 px.
 */
export type TokenMarks = {
  chip: number;
  gap: number;
  /** Text sizes inside a chip: its letters, and the counter in its corner. */
  glyphPx: number;
  counterPx: number;
  xs: number[];
  shown: number;
  overflow: number;
  badge: { text: string; x: number; y: number; width: number; height: number; textPx: number } | null;
  /** The HP bar's box, or null when the viewer sees no bar. */
  bar: Box | null;
  /** Where a label under the token starts, below the bar. */
  belowY: number;
  /** Where a label over the token ends, over the chips and badge. */
  aboveY: number;
  /** Where a label beside the token may start at the highest, under the chips and badge. */
  sideTopY: number;
  /** The chip row's and the badge's boxes, which other labels keep off. */
  boxes: Box[];
  /**
   * The AC shield in the bottom left corner (docs/design-v1-token-panel.md
   * 3.9), or null where it gives way. Like the lock, it sits inside the
   * token's own body, which labels already keep off, so neither is in `boxes`.
   */
  ac: { text: string; x: number; y: number; width: number; height: number; textPx: number } | null;
  /** The padlock's square: its corner, or above the AC shield. Null when no lock shows. */
  lock: { x: number; y: number; size: number } | null;
};

type Measure = (text: string, px: number) => number;

export function tokenMarks(input: {
  widthPx: number;
  heightPx: number;
  effects: readonly Effect[];
  elevation: number;
  hasBar: boolean;
  cellPx: number;
  sizes: BoardSizes;
  measure: Measure;
  /** The AC to show on its shield, already checked: a creature, alive, 1 to 100, with HP to show. Null for none. */
  ac?: number | null;
  /** Whether the padlock shows (Stage.tsx lockShown). */
  lock?: boolean;
  /** The width a number badge may take at the bottom right, which the AC shield leaves free: numberBadgeWidth for a picture token with a number, else 0. */
  numberReserve?: number;
}): TokenMarks {
  const { widthPx, heightPx, effects, sizes, measure } = input;
  const gap = Math.max(1, Math.round(sizes.gapPx * 0.67));
  const badgeText = elevationBadge(input.elevation);
  const badge = badgeText
    ? { text: badgeText, width: Math.ceil(measure(badgeText, sizes.badgeTextPx)) + 12, height: Math.ceil(sizes.badgeTextPx + 7), textPx: sizes.badgeTextPx }
    : null;
  const rowAt = (chip: number) => chipRow(widthPx, effects.length, badge !== null, { chip, gap, badge: (badge?.width ?? 0) + gap });
  let chip = sizes.chipPx;
  let row = rowAt(chip);
  const shownEffects = effects.slice(0, row.shown);
  const texts = shownEffects.flatMap((e) => (e.key === "custom" ? [effectChip(e).glyph] : []));
  if (row.overflow > 0) texts.push(`+${row.overflow}`);
  const counters = shownEffects.some((e) => effectCount(e) !== null);
  if (texts.length > 0 || counters) {
    const widest = Math.max(0, ...texts.map((t) => measure(t, sizes.chipTextPx)));
    chip = Math.max(chipFit(sizes, widest), counters ? Math.ceil(sizes.counterPx + 7) : 0);
    row = rowAt(chip);
  }
  const chipsBox: Box | null = row.xs.length > 0 ? { x0: 0, y0: -chip / 2, x1: row.xs[row.xs.length - 1]! + chip, y1: chip / 2 } : null;
  const badgePlaced = badge ? { ...badge, x: badgeLeft(widthPx, row.xs, { chip, gap, inset: badge.width }), y: -badge.height / 2 } : null;
  const badgeBox: Box | null = badgePlaced ? { x0: badgePlaced.x, y0: badgePlaced.y, x1: badgePlaced.x + badgePlaced.width, y1: badgePlaced.y + badgePlaced.height } : null;
  const barWidth = Math.max(24, Math.min(widthPx, 3 * input.cellPx));
  const bar: Box | null = input.hasBar
    ? { x0: (widthPx - barWidth) / 2, y0: heightPx + sizes.gapPx, x1: (widthPx + barWidth) / 2, y1: heightPx + sizes.gapPx + sizes.barPx }
    : null;
  const boxes = [chipsBox, badgeBox, bar].filter((b): b is Box => b !== null);
  const top = Math.min(0, chipsBox?.y0 ?? 0, badgeBox?.y0 ?? 0);
  const corner = cornerMarks({ widthPx, heightPx, chip, gap, sizes, measure, ac: input.ac ?? null, lock: input.lock === true, numberReserve: input.numberReserve ?? 0 });
  return {
    chip,
    gap,
    glyphPx: sizes.chipTextPx,
    counterPx: sizes.counterPx,
    xs: row.xs,
    shown: row.shown,
    overflow: row.overflow,
    badge: badgePlaced,
    bar,
    belowY: (bar ? bar.y1 : heightPx) + sizes.gapPx,
    aboveY: top - sizes.gapPx,
    sideTopY: Math.max(chipsBox?.y1 ?? 0, badgeBox?.y1 ?? 0) + sizes.gapPx,
    boxes,
    ...corner,
  };
}

/**
 * The bottom left corner: the AC shield and the padlock. The shield is
 * `ceil(badgeTextPx + 9)` tall and as wide as its number plus 8, at least
 * 0.85 of its height, so 1, 2 or 3 digits fit. It shows on a token at
 * least twice its height tall whose width also holds a gap and the number
 * badge that may take the bottom right. Without a shield the lock keeps
 * its corner. With one it stands just above the shield on the left edge,
 * where the token is tall enough to keep it under the chip row. Where it
 * is not, the shield gives way and the lock keeps its corner, since a drag
 * that does nothing needs its reason more than the AC, which the bar and
 * the tracker still say.
 */
function cornerMarks(input: {
  widthPx: number;
  heightPx: number;
  chip: number;
  gap: number;
  sizes: BoardSizes;
  measure: Measure;
  ac: number | null;
  lock: boolean;
  numberReserve: number;
}): Pick<TokenMarks, "ac" | "lock"> {
  const { widthPx, heightPx, gap, sizes } = input;
  const lockSize = sizes.chipPx;
  const cornerLock = input.lock ? { x: 0, y: heightPx - lockSize, size: lockSize } : null;
  if (input.ac === null) return { ac: null, lock: cornerLock };
  const text = String(input.ac);
  const textPx = sizes.badgeTextPx;
  const height = Math.ceil(textPx + 9);
  const width = Math.max(Math.ceil(height * 0.85), Math.ceil(input.measure(text, textPx) + 8));
  if (heightPx < 2 * height || widthPx < width + gap + input.numberReserve) return { ac: null, lock: cornerLock };
  const ac = { text, x: 0, y: heightPx - height, width, height, textPx };
  if (!input.lock) return { ac, lock: null };
  const lockTop = heightPx - height - gap - lockSize;
  if (lockTop < input.chip / 2 + gap) return { ac: null, lock: cornerLock };
  return { ac, lock: { x: 0, y: lockTop, size: lockSize } };
}

/**
 * The AC a token's shield shows (docs/design-v1-token-panel.md 3.9), or
 * null: a creature whose actor this viewer's copy holds an AC of 1 to 100
 * for, alive or dying, with HP to show. The projection decides who holds
 * an AC (the DM every creature's, a player their own), so nothing here
 * asks about the viewer. A corpse's AC answers nothing, and an effect has
 * none to answer, whatever its actor stores.
 */
export function shieldAc(token: { kind: TokenKind; companion?: unknown }, actor: Partial<Actor> | undefined): number | null {
  if (token.kind === "object") return null;
  const ac = actor?.ac;
  if (typeof ac !== "number" || !Number.isInteger(ac) || ac < 1 || ac > 100) return null;
  if (actor?.life === "dead" || hpLess(actor, token)) return null;
  return ac;
}

/** The number badge's width at the bottom right of a numbered picture token (TokenNode.tsx NumberBadge). */
export function numberBadgeWidth(number: number, px: number): number {
  const d = Math.ceil(px + 6);
  return Math.max(d, Math.ceil(String(number).length * px * 0.62 + 8));
}

/** Below this many screen pixels across, a token is too small for its notch to read as a shape. */
export const NOTCH_MIN_TOKEN_PX = 8;

export type Notch = { points: number[]; strokeWidth: number };

/**
 * A Bloodied creature's mark: a triangle notch cut into the right of its
 * ring, pointing in, in screen pixels from the token's top-left corner. It
 * is drawn whenever `state` (healthState, which is null when this viewer
 * may not know the creature's HP) says Bloodied, at every zoom, not only
 * while the token is big enough for chips and a bar: on a phone fitted to
 * a whole scene it is the one sign left of who is hurt. It shrinks with the
 * token, about a third of it, or near half on a small one so it stays a
 * visible shape, and is left out only on a token too small to show one.
 */
export function bloodiedNotch(state: HpLabel | null, widthPx: number, heightPx: number, ringPx: number): Notch | null {
  if (state !== "Bloodied") return null;
  const d = Math.min(widthPx, heightPx);
  if (d < NOTCH_MIN_TOKEN_PX) return null;
  const base = Math.min(16, Math.max(4, d * 0.32, Math.min(9, d * 0.45)));
  const depth = base * 0.7;
  const edge = widthPx + ringPx / 2;
  const cy = heightPx / 2;
  return { points: [edge, cy - base / 2, edge, cy + base / 2, edge - depth, cy], strokeWidth: d < 20 ? 1 : 1.5 };
}
