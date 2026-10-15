import type { Label } from "../model.ts";

/**
 * Where a map label's text sits (design sections 12 and 13.4), as one box
 * definition with two ways to get the text's width:
 *
 * - The builder's tap and its outline measure the text on a canvas
 *   (`measure`), so a tap picks exactly the label drawn under the finger.
 * - Everything that must agree between devices, or runs where no canvas
 *   can measure, uses the estimate: an erase in the reducer, the erase
 *   preview that shows what it will take, and the projection that withholds
 *   a label under the fog (rules/fog.ts labelCells). The bold label font
 *   runs close to the estimate, so these match what is drawn to within a
 *   letter or so.
 */

/** A label's text width in ems, for a font of size 1. */
export type MeasureText = (text: string) => number;

/** About 0.6 em per character of the bold label font, for where no canvas can measure, the reducer included. */
export const estimateText: MeasureText = (text) => text.length * 0.6;

export type LabelBox = { x0: number; y0: number; x1: number; y1: number };

/**
 * The box a label draws in, in cells: its text centered on its anchor, a
 * font size of `size` cells, and the dark halo around the letters.
 */
export function labelBox(label: Pick<Label, "x" | "y" | "text" | "size">, measure: MeasureText = estimateText): LabelBox {
  const halfW = (measure(label.text) / 2 + 0.08) * label.size;
  const halfH = 0.5 * label.size;
  return { x0: label.x - halfW, y0: label.y - halfH, x1: label.x + halfW, y1: label.y + halfH };
}

/**
 * Whether a box covers any part of the cell whose top-left corner is x, y.
 * Callers test a box against each cell they hold instead of listing the
 * cells a box covers: a label 80 characters long at size 20 covers about
 * 20,000 cells, and 500 of them made every erase cost a third of a second.
 */
export function boxTouchesCell(box: LabelBox, x: number, y: number): boolean {
  return x < box.x1 && x + 1 > box.x0 && y < box.y1 && y + 1 > box.y0;
}
