import type { Effect } from "#shared/model.ts";
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
  };
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
