import type { Drawing } from "#shared/model.ts";
import { textCells } from "./geometry.ts";

/**
 * A text drawing's box in cells as Top-down draws it (DrawingLayer.tsx): its
 * lines from its anchor at the top left, `textCells` tall each, the widest
 * line wide, grown on every side by the halo and by how far the letters'
 * ink reaches past the lines' boxes, so the stand rule tests every
 * sub-cell a letter can touch (docs/design-v1-isometric-view.md 5.2).
 * `measure` gives a line's width in ems of the bold board font.
 */
export type MeasureEm = (line: string) => number;

/**
 * How far past a line's box its ink can reach, in ems. Konva sets each line
 * on an alphabetic baseline below the line's middle, and in Chrome the bold
 * board font's accented capitals reach 0.14 em over the line's box and its
 * descenders 0.10 under it, and a letter's ink 0.035 em past its advance,
 * the halo apart. Generous, so the box fails closed.
 */
export const TEXT_INK_EM = 0.3;

export function textDrawingBox(d: Pick<Drawing, "points" | "text" | "style">, measure: MeasureEm): { x0: number; y0: number; x1: number; y1: number } {
  const size = textCells(d.style.width);
  const lines = (d.text ?? "").split("\n");
  const width = Math.max(0, ...lines.map((l) => measure(l))) * size;
  // The halo's stroke is centered on the letters' edges, so half of it lies outside them. All of it counts, to fail closed.
  const pad = size / 14 + TEXT_INK_EM * size;
  const x = d.points[0] ?? 0;
  const y = d.points[1] ?? 0;
  return { x0: x - pad, y0: y - pad, x1: x + width + pad, y1: y + lines.length * size + pad };
}
